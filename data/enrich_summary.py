#!/usr/bin/env python3
"""Add distance/yield and carrier-share metrics to an AeroYield site summary."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def distance_metrics(rows: pd.DataFrame, total_passengers: float) -> dict[str, float | None]:
    valid = rows[
        (rows["distance"].fillna(0) > 0)
        & rows["fare"].notna()
        & (rows["fare"] >= 0)
    ].copy()
    covered_passengers = float(valid["passengers"].sum())
    if covered_passengers <= 0:
        return {
            "avgDistance": None,
            "yieldPerMile": None,
            "distanceCoverage": 0.0,
        }

    passenger_miles = float((valid["distance"] * valid["passengers"]).sum())
    fare_passengers = float((valid["fare"] * valid["passengers"]).sum())
    avg_distance = passenger_miles / covered_passengers
    yield_per_mile = fare_passengers / passenger_miles if passenger_miles > 0 else None

    return {
        "avgDistance": round(avg_distance, 1),
        "yieldPerMile": round(yield_per_mile, 6) if yield_per_mile is not None else None,
        "distanceCoverage": round(covered_passengers / total_passengers, 4) if total_passengers else 0.0,
    }


def build_enrichment(markets: pd.DataFrame) -> dict[tuple[str, str], dict]:
    required = {"origin", "destination", "carrier", "passengers", "fare", "distance"}
    missing = required - set(markets.columns)
    if missing:
        raise KeyError(f"Normalized market file is missing: {', '.join(sorted(missing))}")

    df = markets.copy()
    for column in ["passengers", "fare", "distance", "year", "month"]:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    df = df[df["passengers"].fillna(0) > 0]

    result: dict[tuple[str, str], dict] = {}
    for (origin, destination), route in df.groupby(["origin", "destination"], dropna=False):
        passengers = float(route["passengers"].sum())
        route_metrics = distance_metrics(route, passengers)

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

        monthly_enrichment: dict[str, dict[str, float | None]] = {}
        if {"year", "month"}.issubset(route.columns):
            monthly = route.dropna(subset=["year", "month"]).copy()
            if not monthly.empty:
                monthly["period"] = (
                    monthly["year"].astype(int).astype(str)
                    + "-"
                    + monthly["month"].astype(int).astype(str).str.zfill(2)
                )
                for period, period_rows in monthly.groupby("period"):
                    period_passengers = float(period_rows["passengers"].sum())
                    monthly_enrichment[str(period)] = distance_metrics(period_rows, period_passengers)

        result[(str(origin), str(destination))] = {
            **route_metrics,
            "topCarriers": top_carriers,
            "carrierCoverage": round(known_carrier_pax / passengers, 4) if passengers else 0.0,
            "monthlyEnrichment": monthly_enrichment,
        }
    return result


def enrich_summary(markets_path: Path, summary_path: Path, output_path: Path) -> None:
    markets = pd.read_parquet(markets_path)
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    enrichment = build_enrichment(markets)

    default_enrichment = {
        "avgDistance": None,
        "yieldPerMile": None,
        "distanceCoverage": 0.0,
        "topCarriers": [],
        "carrierCoverage": 0.0,
        "monthlyEnrichment": {},
    }

    for market in summary:
        key = (str(market.get("origin", "")), str(market.get("destination", "")))
        route_enrichment = enrichment.get(key, default_enrichment)
        market.update({
            "avgDistance": route_enrichment["avgDistance"],
            "yieldPerMile": route_enrichment["yieldPerMile"],
            "distanceCoverage": route_enrichment["distanceCoverage"],
            "topCarriers": route_enrichment["topCarriers"],
            "carrierCoverage": route_enrichment["carrierCoverage"],
        })

        monthly_enrichment = route_enrichment.get("monthlyEnrichment", {})
        for point in market.get("monthly", []):
            point_enrichment = monthly_enrichment.get(str(point.get("month", "")))
            if point_enrichment:
                point.update(point_enrichment)
            else:
                point.update({
                    "avgDistance": None,
                    "yieldPerMile": None,
                    "distanceCoverage": 0.0,
                })

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
