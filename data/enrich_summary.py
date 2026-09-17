#!/usr/bin/env python3
"""Add distance/yield and carrier-share metrics to an AeroYield site summary."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq


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


def build_enrichment_streaming(markets_path: Path, batch_size: int = 10_000) -> dict[tuple[str, str], dict]:
    """Build enrichment without loading the complete Parquet file into RAM."""
    columns = ["origin", "destination", "carrier", "passengers", "fare", "distance", "year", "month"]
    aggregates: dict[tuple[str, str], dict] = {}

    def route_for(key: tuple[str, str]) -> dict:
        return aggregates.setdefault(
            key,
            {
                "passengers": 0.0,
                "covered_passengers": 0.0,
                "passenger_miles": 0.0,
                "fare_passengers": 0.0,
                "carrier_pax": {},
                "monthly": {},
            },
        )

    parquet = pq.ParquetFile(markets_path)
    for record_batch in parquet.iter_batches(batch_size=batch_size, columns=columns):
        frame = record_batch.to_pandas()
        frame["passengers"] = pd.to_numeric(frame["passengers"], errors="coerce")
        frame["fare"] = pd.to_numeric(frame["fare"], errors="coerce")
        frame["distance"] = pd.to_numeric(frame["distance"], errors="coerce")
        frame["year"] = pd.to_numeric(frame["year"], errors="coerce")
        frame["month"] = pd.to_numeric(frame["month"], errors="coerce")
        frame = frame[frame["passengers"].fillna(0) > 0]

        for row in frame.itertuples(index=False):
            if pd.isna(row.origin) or pd.isna(row.destination):
                continue
            key = (str(row.origin), str(row.destination))
            route = route_for(key)
            passengers = float(row.passengers)
            fare = float(row.fare) if pd.notna(row.fare) and row.fare >= 0 else None
            distance = float(row.distance) if pd.notna(row.distance) and row.distance > 0 else None
            route["passengers"] += passengers
            if fare is not None:
                route["fare_passengers"] += fare * passengers
            if fare is not None and distance is not None:
                route["covered_passengers"] += passengers
                route["passenger_miles"] += distance * passengers

            if pd.notna(row.carrier):
                carrier = str(row.carrier)
                route["carrier_pax"][carrier] = route["carrier_pax"].get(carrier, 0.0) + passengers

            if pd.notna(row.year) and pd.notna(row.month):
                period = f"{int(row.year)}-{int(row.month):02d}"
                monthly = route["monthly"].setdefault(
                    period,
                    {"passengers": 0.0, "covered_passengers": 0.0, "passenger_miles": 0.0, "fare_passengers": 0.0},
                )
                monthly["passengers"] += passengers
                if fare is not None:
                    monthly["fare_passengers"] += fare * passengers
                if fare is not None and distance is not None:
                    monthly["covered_passengers"] += passengers
                    monthly["passenger_miles"] += distance * passengers

    result = {}
    for key, route in aggregates.items():
        passengers = route["passengers"]
        covered = route["covered_passengers"]
        miles = route["passenger_miles"]
        carrier_pax = sorted(route["carrier_pax"].items(), key=lambda item: item[1], reverse=True)
        known_carrier_pax = sum(route["carrier_pax"].values())

        def metrics(values: dict) -> dict[str, float | None]:
            covered_passengers = values["covered_passengers"]
            passenger_miles = values["passenger_miles"]
            return {
                "avgDistance": round(passenger_miles / covered_passengers, 1) if covered_passengers else None,
                "yieldPerMile": round(values["fare_passengers"] / passenger_miles, 6) if passenger_miles else None,
                "distanceCoverage": round(covered_passengers / values["passengers"], 4) if values["passengers"] else 0.0,
            }

        result[key] = {
            **metrics(route),
            "topCarriers": [
                {"carrier": carrier, "passengers": round(pax), "share": round(pax / known_carrier_pax, 4)}
                for carrier, pax in carrier_pax[:5]
            ],
            "carrierCoverage": round(known_carrier_pax / passengers, 4) if passengers else 0.0,
            "monthlyEnrichment": {period: metrics(values) for period, values in route["monthly"].items()},
        }
    return result


def enrich_summary(markets_path: Path, summary_path: Path, output_path: Path) -> None:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    enrichment = build_enrichment_streaming(markets_path)

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
