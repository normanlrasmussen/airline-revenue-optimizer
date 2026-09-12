#!/usr/bin/env python3
"""Add distance/yield and carrier-share metrics to an AeroYield site summary."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def build_enrichment(markets: pd.DataFrame) -> dict[tuple[str, str], dict]:
    required = {"origin", "destination", "carrier", "passengers", "fare", "distance"}
    missing = required - set(markets.columns)
    if missing:
        raise KeyError(f"Normalized market file is missing: {', '.join(sorted(missing))}")

    df = markets.copy()
    df["passengers"] = pd.to_numeric(df["passengers"], errors="coerce")
    df["distance"] = pd.to_numeric(df["distance"], errors="coerce")
    df = df[df["passengers"].fillna(0) > 0]

    result: dict[tuple[str, str], dict] = {}
    for (origin, destination), route in df.groupby(["origin", "destination"], dropna=False):
        passengers = float(route["passengers"].sum())
        distance_rows = route[route["distance"].fillna(0) > 0].copy()
        distance_weight = float(distance_rows["passengers"].sum())
        avg_distance = None
        if distance_weight > 0:
            avg_distance = float((distance_rows["distance"] * distance_rows["passengers"]).sum() / distance_weight)

        carrier_rows = route.dropna(subset=["carrier"])
        carrier_pax = carrier_rows.groupby("carrier")["passengers"].sum().sort_values(ascending=False)
        known_carrier_pax = float(carrier_pax.sum())
        top_carriers = [
            {
                "carrier": str(carrier),
                "passengers": round(float(pax)),
                "share": round(float(pax) / known_carrier_pax, 4) if known_carrier_pax else 0.0,
            }
            for carrier, pax in carrier_pax.head(5).items()
        ]
        result[(str(origin), str(destination))] = {
            "avgDistance": round(avg_distance, 1) if avg_distance is not None else None,
            "distanceCoverage": round(distance_weight / passengers, 4) if passengers else 0.0,
            "topCarriers": top_carriers,
            "carrierCoverage": round(known_carrier_pax / passengers, 4) if passengers else 0.0,
        }
    return result


def enrich_summary(markets_path: Path, summary_path: Path, output_path: Path) -> None:
    markets = pd.read_parquet(markets_path)
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    enrichment = build_enrichment(markets)

    for market in summary:
        key = (str(market.get("origin", "")), str(market.get("destination", "")))
        market.update(enrichment.get(key, {
            "avgDistance": None,
            "distanceCoverage": 0.0,
            "topCarriers": [],
            "carrierCoverage": 0.0,
        }))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--markets", type=Path, default=Path("data/processed/markets.parquet"))
    parser.add_argument("--summary", type=Path, default=Path("site/data/market_summary.json"))
    parser.add_argument("--output", type=Path, default=Path("site/data/market_summary.json"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    enrich_summary(args.markets, args.summary, args.output)
    print(f"Enriched {args.output}")


if __name__ == "__main__":
    main()
