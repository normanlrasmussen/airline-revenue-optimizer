import json
import sys

import pytest

from data import process_db1c


def test_process_pipeline_writes_enriched_yield_metrics(tmp_path, monkeypatch):
    source = tmp_path / "market.csv"
    parquet = tmp_path / "markets.parquet"
    summary = tmp_path / "market_summary.json"

    source.write_text(
        "Origin,Dest,RpCarrier,Passengers,MktFare,MktDistance,RpYear,RpMonth\n"
        "AAA,BBB,X,80,200,1000,2026,1\n"
        "AAA,BBB,Y,20,250,1200,2026,1\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "process_db1c.py",
            "--input",
            str(source),
            "--output",
            str(parquet),
            "--site-summary",
            str(summary),
        ],
    )

    process_db1c.main()

    markets = json.loads(summary.read_text(encoding="utf-8"))
    assert len(markets) == 1
    market = markets[0]

    expected_yield = (80 * 200 + 20 * 250) / (80 * 1000 + 20 * 1200)
    assert market["avgDistance"] == pytest.approx(1040.0)
    assert market["yieldPerMile"] == pytest.approx(expected_yield, abs=1e-6)
    assert market["distanceCoverage"] == pytest.approx(1.0)
    assert market["topCarriers"][0]["carrier"] == "X"
    assert market["topCarriers"][0]["share"] == pytest.approx(0.8)

    monthly = market["monthly"][0]
    assert monthly["avgDistance"] == pytest.approx(1040.0)
    assert monthly["yieldPerMile"] == pytest.approx(expected_yield, abs=1e-6)
    assert monthly["distanceCoverage"] == pytest.approx(1.0)


def test_resolve_inputs_reports_missing_path_clearly(tmp_path):
    missing = tmp_path / "raw"

    with pytest.raises(FileNotFoundError, match="Input path does not exist"):
        process_db1c.resolve_inputs([missing])


def test_resolve_inputs_reports_empty_directory_clearly(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(ValueError, match="No \\.zip, \\.csv, or \\.parquet input files were found"):
        process_db1c.resolve_inputs([raw])


def test_resolve_inputs_accepts_parquet_from_directory(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    parquet = raw / "market.parquet"
    parquet.touch()

    assert process_db1c.resolve_inputs([raw]) == [parquet]
