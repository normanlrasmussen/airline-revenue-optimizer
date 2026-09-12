import pandas as pd
import pytest

from data.enrich_summary import build_enrichment


def test_enrichment_computes_passenger_weighted_distance_and_carrier_share():
    df = pd.DataFrame(
        [
            {"origin": "AAA", "destination": "BBB", "carrier": "X", "passengers": 80, "fare": 200, "distance": 1000},
            {"origin": "AAA", "destination": "BBB", "carrier": "Y", "passengers": 20, "fare": 250, "distance": 1200},
        ]
    )

    enriched = build_enrichment(df)[("AAA", "BBB")]

    assert enriched["avgDistance"] == pytest.approx(1040.0)
    assert enriched["distanceCoverage"] == pytest.approx(1.0)
    assert enriched["carrierCoverage"] == pytest.approx(1.0)
    assert enriched["topCarriers"][0]["carrier"] == "X"
    assert enriched["topCarriers"][0]["share"] == pytest.approx(0.8)
    assert enriched["topCarriers"][1]["share"] == pytest.approx(0.2)


def test_enrichment_handles_missing_distance_and_carrier_values():
    df = pd.DataFrame(
        [
            {"origin": "AAA", "destination": "CCC", "carrier": None, "passengers": 50, "fare": 150, "distance": None},
        ]
    )

    enriched = build_enrichment(df)[("AAA", "CCC")]
    assert enriched["avgDistance"] is None
    assert enriched["distanceCoverage"] == 0
    assert enriched["carrierCoverage"] == 0
    assert enriched["topCarriers"] == []
