import pytest

from optimization.revenue_management import FareDemand
from optimization.simulation import (
    PERIODS,
    build_probabilities,
    generate_stream,
    simulate_replication,
)


CLASSES = [
    FareDemand("Saver", 180, 80),
    FareDemand("Main", 320, 45),
    FareDemand("Flex", 620, 20),
]


def test_probability_profiles_preserve_expected_class_demand():
    probabilities = build_probabilities(CLASSES)
    assert len(probabilities) == PERIODS
    for fc in CLASSES:
        expected = sum(row[fc.name] for row in probabilities)
        assert expected == pytest.approx(fc.mean_demand, rel=1e-10, abs=1e-10)
    assert max(sum(row.values()) for row in probabilities) <= 1.0


def test_seeded_stream_is_reproducible():
    probabilities = build_probabilities(CLASSES)
    first = generate_stream(CLASSES, probabilities, 12345)
    second = generate_stream(CLASSES, probabilities, 12345)
    third = generate_stream(CLASSES, probabilities, 12346)

    assert first == second
    assert first != third


def test_replication_is_reproducible_and_clairvoyant_is_upper_bound():
    first = simulate_replication(CLASSES, capacity=100, seed=20260912)
    second = simulate_replication(CLASSES, capacity=100, seed=20260912)

    assert first == second
    for policy in ["open", "emsr", "dp"]:
        assert first["clairvoyant"].revenue + 1e-9 >= first[policy].revenue
        assert 0 <= first[policy].load_factor <= 1
        assert first[policy].accepted + first[policy].empty_seats == 100


def test_high_capacity_causes_no_capacity_spoilage_error():
    result = simulate_replication(CLASSES, capacity=300, seed=777)
    for policy in ["open", "emsr", "dp", "clairvoyant"]:
        assert result[policy].accepted <= 300
        assert result[policy].empty_seats >= 0
