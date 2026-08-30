from optimization.seat_optimizer import FareClass, first_come_baseline, optimize_seats


def test_optimizer_respects_capacity_and_demand():
    classes = [FareClass("Low", 100, 8), FareClass("High", 300, 5)]
    result = optimize_seats(10, classes)

    assert result.seats_sold <= 10
    assert result.allocation["Low"] <= 8
    assert result.allocation["High"] <= 5


def test_optimizer_prioritizes_higher_revenue_when_capacity_is_tight():
    classes = [FareClass("Low", 100, 10), FareClass("High", 300, 5)]
    result = optimize_seats(10, classes)

    assert result.allocation == {"Low": 5, "High": 5}
    assert result.revenue == 2000


def test_optimizer_beats_low_fare_first_baseline():
    classes = [
        FareClass("Saver", 179, 120),
        FareClass("Main", 319, 70),
        FareClass("Flex", 629, 35),
    ]
    baseline = first_come_baseline(180, classes)
    optimized = optimize_seats(180, classes)

    assert optimized.revenue >= baseline.revenue


def test_zero_capacity():
    classes = [FareClass("Flex", 500, 20)]
    result = optimize_seats(0, classes)
    assert result.revenue == 0
    assert result.load_factor == 0
