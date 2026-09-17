import pytest

from optimization.revenue_management import FareDemand
from optimization.simulation import (
    BookingEvent,
    LCG,
    PERIODS,
    build_probabilities,
    build_realized_probabilities,
    generate_stream,
    run_policy,
    simulate_replication,
)


CLASSES = [
    FareDemand("Saver", 180, 80),
    FareDemand("Main", 320, 45),
    FareDemand("Flex", 620, 20),
]


def test_forecast_probability_profiles_preserve_expected_class_demand():
    probabilities = build_probabilities(CLASSES)
    assert len(probabilities) == PERIODS
    for fc in CLASSES:
        expected = sum(row[fc.name] for row in probabilities)
        assert expected == pytest.approx(fc.mean_demand, rel=1e-10, abs=1e-10)
    assert max(sum(row.values()) for row in probabilities) <= 1.0


def test_realized_probabilities_are_seeded_correlated_and_differ_from_forecast():
    first = build_realized_probabilities(
        CLASSES,
        LCG(12345),
        forecast_error_pct=20,
        timing_jitter_days=18,
    )
    second = build_realized_probabilities(
        CLASSES,
        LCG(12345),
        forecast_error_pct=20,
        timing_jitter_days=18,
    )
    forecast = build_probabilities(CLASSES)

    assert first == second
    assert first != forecast
    assert len(first) == PERIODS
    assert max(sum(row.values()) for row in first) <= 0.98 + 1e-12


def test_seeded_stream_is_reproducible_and_contains_party_sizes_and_attrition_flags():
    probabilities = build_probabilities(CLASSES)
    first = generate_stream(
        CLASSES,
        probabilities,
        12345,
        cancellation_rate=0.15,
        no_show_rate=0.10,
    )
    second = generate_stream(
        CLASSES,
        probabilities,
        12345,
        cancellation_rate=0.15,
        no_show_rate=0.10,
    )
    third = generate_stream(
        CLASSES,
        probabilities,
        12346,
        cancellation_rate=0.15,
        no_show_rate=0.10,
    )

    assert first == second
    assert first != third
    assert first
    assert all(1 <= event.party_size <= 4 for event in first)
    assert any(event.party_size > 1 for event in first)
    assert all(event.cancel_period is None or event.cancel_period > event.period for event in first)
    assert all(not (event.will_cancel and event.will_no_show) for event in first)


def test_attrition_assumptions_do_not_change_arrivals_or_party_sizes():
    probabilities = build_probabilities(CLASSES)
    low_attrition = generate_stream(
        CLASSES,
        probabilities,
        98765,
        cancellation_rate=0.0,
        no_show_rate=0.0,
    )
    high_attrition = generate_stream(
        CLASSES,
        probabilities,
        98765,
        cancellation_rate=0.30,
        no_show_rate=0.20,
    )

    low_core = [(event.period, event.name, event.party_size) for event in low_attrition]
    high_core = [(event.period, event.name, event.party_size) for event in high_attrition]
    assert low_core == high_core


def test_no_show_keeps_revenue_but_does_not_consume_departure_capacity():
    events = [
        BookingEvent(
            period=0,
            day=180,
            name="Saver",
            fare=100,
            party_size=1,
            will_no_show=True,
        ),
        BookingEvent(
            period=1,
            day=180,
            name="Main",
            fare=200,
            party_size=1,
        ),
    ]

    outcome = run_policy(
        events,
        capacity=1,
        booking_limit=2,
        accept=lambda _event, _remaining: True,
    )

    assert outcome.accepted == 2
    assert outcome.no_show == 1
    assert outcome.boarded == 1
    assert outcome.denied_boarding == 0
    assert outcome.empty_seats == 0
    assert outcome.gross_revenue == 300
    assert outcome.revenue == 300


def test_replication_is_reproducible_and_oracle_is_upper_bound():
    first = simulate_replication(CLASSES, capacity=100, seed=20260912)
    second = simulate_replication(CLASSES, capacity=100, seed=20260912)

    assert first == second
    for policy in ["open", "emsr", "dp"]:
        outcome = first[policy]
        assert first["clairvoyant"].revenue + 1e-9 >= outcome.revenue
        assert 0 <= outcome.load_factor <= 1
        assert outcome.boarded + outcome.empty_seats == 100
        assert outcome.accepted == (
            outcome.boarded
            + outcome.cancelled
            + outcome.no_show
            + outcome.denied_boarding
        )
        assert outcome.refunds >= 0


def test_high_capacity_has_no_denied_boarding_when_overbooking_is_disabled():
    result = simulate_replication(
        CLASSES,
        capacity=300,
        seed=777,
        overbooking_pct=0,
    )
    for policy in ["open", "emsr", "dp", "clairvoyant"]:
        assert result[policy].boarded <= 300
        assert result[policy].empty_seats >= 0
        assert result[policy].denied_boarding == 0
