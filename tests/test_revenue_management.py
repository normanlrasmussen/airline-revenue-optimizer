import pytest

from optimization.revenue_management import (
    FareDemand,
    clairvoyant_allocation,
    deterministic_lp_bid_price,
    emsr_b,
    emsr_b_accept,
    gamma_poisson_demand_scale,
    open_sales_accept,
    scale_probability_schedule,
    solve_deterministic_lp_bid_prices,
    solve_distributionally_robust_dp,
    solve_finite_horizon_dp,
)


def test_open_sales_only_requires_capacity():
    assert open_sales_accept(1)
    assert not open_sales_accept(0)


def test_emsr_b_returns_valid_nested_protection_levels():
    classes = [
        FareDemand("Saver", 180, 120),
        FareDemand("Main", 320, 70),
        FareDemand("Flex", 620, 35),
    ]
    result = emsr_b(180, classes)

    assert [fc.name for fc in result.ordered_classes] == ["Flex", "Main", "Saver"]
    assert result.protection_for_request["Flex"] == 0
    assert 0 <= result.protection_for_request["Main"] <= 180
    assert result.protection_for_request["Main"] <= result.protection_for_request["Saver"] <= 180
    assert result.booking_limit["Saver"] == 180 - result.protection_for_request["Saver"]


def test_emsr_accepts_only_above_protection_level():
    result = emsr_b(
        20,
        [FareDemand("Low", 100, 20), FareDemand("High", 300, 5)],
    )
    protect = result.protection_for_request["Low"]
    assert not emsr_b_accept(result, "Low", protect)
    if protect < 20:
        assert emsr_b_accept(result, "Low", protect + 1)


def test_one_period_dp_matches_direct_expected_revenue():
    dp = solve_finite_horizon_dp(
        capacity=1,
        class_fares={"Low": 100, "High": 300},
        period_request_probabilities=[{"Low": 0.5, "High": 0.5}],
    )
    assert dp.expected_revenue == pytest.approx(200.0)
    assert dp.accept(0, 1, 100)


def test_dp_protects_seat_for_certain_higher_future_fare():
    dp = solve_finite_horizon_dp(
        capacity=1,
        class_fares={"Low": 100, "High": 300},
        period_request_probabilities=[{"Low": 1.0}, {"High": 1.0}],
    )
    assert dp.expected_revenue == pytest.approx(300.0)
    assert dp.bid_prices[0][1] == pytest.approx(300.0)
    assert not dp.accept(0, 1, 100)
    assert dp.accept(1, 1, 300)


def test_dp_rejects_invalid_probability_mass():
    with pytest.raises(ValueError):
        solve_finite_horizon_dp(1, {"A": 100}, [{"A": 1.01}])


def test_deterministic_lp_bid_price_is_marginal_fare():
    fares = {"Low": 100, "High": 300}
    demand = {"Low": 10, "High": 2}

    assert deterministic_lp_bid_price(1, fares, demand) == 300
    assert deterministic_lp_bid_price(2, fares, demand) == 300
    assert deterministic_lp_bid_price(3, fares, demand) == 100
    assert deterministic_lp_bid_price(20, fares, demand) == 0


def test_time_varying_lp_bid_price_uses_only_remaining_forecast():
    result = solve_deterministic_lp_bid_prices(
        2,
        {"Low": 100, "High": 300},
        [
            {"Low": 0.0, "High": 1.0},
            {"Low": 1.0, "High": 0.0},
        ],
    )

    assert result.bid_prices[0][1] == 300
    assert result.bid_prices[1][1] == 100


def test_gamma_poisson_scale_tracks_booking_pace_and_is_bounded():
    assert gamma_poisson_demand_scale(40, 40) == pytest.approx(1.0)
    assert gamma_poisson_demand_scale(70, 40) > 1.0
    assert gamma_poisson_demand_scale(10, 40) < 1.0
    assert gamma_poisson_demand_scale(10_000, 1) == pytest.approx(1.75)
    assert gamma_poisson_demand_scale(0, 10_000) == pytest.approx(0.5)


def test_scaled_probability_schedule_preserves_class_mix_until_cap():
    schedule = scale_probability_schedule(
        [{"Low": 0.1, "High": 0.2}],
        2.0,
    )
    assert schedule[0]["Low"] == pytest.approx(0.2)
    assert schedule[0]["High"] == pytest.approx(0.4)

    capped = scale_probability_schedule(
        [{"Low": 0.4, "High": 0.4}],
        2.0,
    )[0]
    assert sum(capped.values()) == pytest.approx(0.98)
    assert capped["Low"] == pytest.approx(capped["High"])


def test_zero_radius_robust_dp_matches_nominal_dp():
    fares = {"Low": 100, "High": 300}
    probabilities = [
        {"Low": 0.4, "High": 0.1},
        {"Low": 0.1, "High": 0.4},
    ]
    nominal = solve_finite_horizon_dp(2, fares, probabilities)
    robust = solve_distributionally_robust_dp(
        2,
        fares,
        probabilities,
        tv_radius=0.0,
    )

    assert robust.expected_revenue == pytest.approx(nominal.expected_revenue)
    assert robust.values == pytest.approx(nominal.values)
    assert robust.bid_prices == pytest.approx(nominal.bid_prices)


def test_robust_expected_value_cannot_exceed_nominal_value():
    fares = {"Low": 100, "High": 300}
    probabilities = [
        {"Low": 0.4, "High": 0.1},
        {"Low": 0.1, "High": 0.4},
    ]
    nominal = solve_finite_horizon_dp(2, fares, probabilities)
    robust = solve_distributionally_robust_dp(
        2,
        fares,
        probabilities,
        tv_radius=0.15,
    )

    assert robust.expected_revenue <= nominal.expected_revenue + 1e-12


def test_clairvoyant_upper_bound_takes_highest_realized_fares():
    allocation, revenue = clairvoyant_allocation(
        3,
        {"Low": 5, "High": 2},
        {"Low": 100, "High": 400},
    )
    assert allocation == {"Low": 1, "High": 2}
    assert revenue == 900
