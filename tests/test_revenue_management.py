import pytest

from optimization.revenue_management import (
    FareDemand,
    clairvoyant_allocation,
    emsr_b,
    emsr_b_accept,
    open_sales_accept,
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


def test_clairvoyant_upper_bound_takes_highest_realized_fares():
    allocation, revenue = clairvoyant_allocation(
        3,
        {"Low": 5, "High": 2},
        {"Low": 100, "High": 400},
    )
    assert allocation == {"Low": 1, "High": 2}
    assert revenue == 900
