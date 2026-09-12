import pandas as pd
import pytest

from data.enrich_summary import build_enrichment


def test_enrichment_computes_passenger_weighted_distance_yield_and_carrier_share():
    df = pd.DataFrame(
        [
            {"origin": "AAA", "destination": "BBB", "carrier": "X", "passengers": 80, "fare": 200, "distance": 1000, "year": 2026, "month": 1},
            {"origin": "AAA", "destination": "BBB", "carrier": "Y", "passengers": 20, "fare": 250, "distance": 1200, "year": 2026, "month": 1},
        ]
    )

    enriched = build_enrichment(df)[("AAA", "BBB")]

    assert enriched["avgDistance"] == pytest.approx(1040.0)
    assert enriched["yieldPerMile"] == pytest.approx(21000 / 104000, rel=1e-5)
    assert enriched["distanceCoverage"] == pytest.approx(1.0)
    assert enriched["carrierCoverage"] == pytest.approx(1.0)
    assert enriched["topCarriers"][0]["carrier"] == "X"
    assert enriched["topCarriers"][0]["share"] == pytest.approx(0.8)
    assert enriched["topCarriers"][1]["share"] == pytest.approx(0.2)
    assert enriched["monthlyEnrichment"]["2026-01"]["yieldPerMile"] == pytest.approx(21000 / 104000, rel=1e-5)


def test_yield_excludes_rows_without_distance_from_both_numerator_and_denominator():
    df = pd.DataFrame(
        [
            {"origin": "AAA", "destination": "BBB", "carrier": "X", "passengers": 80, "fare": 200, "distance": 1000, "year": 2026, "month": 1},
            {"origin": "AAA", "destination": "BBB", "carrier": "Y", "passengers": 20, "fare": 1000, "distance": None, "year": 2026, "month": 1},
        ]
    )

    enriched = build_enrichment(df)[("AAA", "BBB")]

    assert enriched["avgDistance"] == pytest.approx(1000.0)
    assert enriched["yieldPerMile"] == pytest.approx(0.2)
    assert enriched["distanceCoverage"] == pytest.approx(0.8)


def test_enrichment_handles_missing_distance_and_carrier_values():
    df = pd.DataFrame(
        [
            {"origin": "AAA", "destination": "CCC", "carrier": None, "passengers": 50, "fare": 150, "distance": None, "year": 2026, "month": 1},
        ]
    )

    enriched = build_enrichment(df)[("AAA", "CCC")]
    assert enriched["avgDistance"] is None
    assert enriched["yieldPerMile"] is None
    assert enriched["distanceCoverage"] == 0
    assert enriched["carrierCoverage"] == 0
    assert enriched["topCarriers"] == []
    assert enriched["monthlyEnrichment"]["2026-01"]["yieldPerMile"] is None
