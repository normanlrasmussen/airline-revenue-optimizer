#!/usr/bin/env python3
"""Normalize BTS DB1C Market ZIP/CSV files into compact analysis tables."""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ALIASES = {
    "origin": ["Origin", "MktOrigin", "MarketOrigin", "OriginAirport", "OriginAirportID"],
    "destination": ["Dest", "Destination", "MktDest", "MarketDestination", "DestAirport"],
    "carrier": ["RpCarrier", "ReportingCarrier", "TkCarrier", "Carrier"],
    "passengers": ["Passengers", "MktPassengers", "PassengerCount", "Pax"],
    "fare": ["MktFare", "MktAmount", "MarketFare", "Fare", "ItinFare", "ProratedMarketFare"],
    "distance": ["MktDistance", "TotalDistance", "MilesTraveled", "NonStopMiles", "MarketDistance", "Distance", "MilesFlown"],
    "year": ["RpYear", "Year", "ReportingYear"],
    "month": ["RpMonth", "Month", "ReportingMonth"],
}

NORMALIZED_SCHEMA = pa.schema(
    [
        ("origin", pa.string()),
        ("destination", pa.string()),
        ("carrier", pa.string()),
        ("passengers", pa.float64()),
        ("fare", pa.float64()),
        ("distance", pa.float64()),
        ("year", pa.float64()),
        ("month", pa.float64()),
    ]
)


def canonical(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def find_column(columns: list[str], aliases: list[str]) -> str | None:
    lookup = {canonical(c): c for c in columns}
    for alias in aliases:
        if canonical(alias) in lookup:
            return lookup[canonical(alias)]
    return None


def iter_input_chunks(path: Path, chunksize: int):
    if path.suffix.lower() == ".csv":
        yield from pd.read_csv(path, low_memory=False, chunksize=chunksize)
        return

    if path.suffix.lower() == ".parquet":
        yield pd.read_parquet(path)
        return

    if path.suffix.lower() != ".zip":
        raise ValueError("Input must be a .zip, .csv, or .parquet file")

    with zipfile.ZipFile(path) as archive:
        csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if csv_names:
            chosen = max(csv_names, key=lambda name: archive.getinfo(name).file_size)
            with archive.open(chosen) as handle:
                yield from pd.read_csv(handle, low_memory=False, chunksize=chunksize)
                return

        parquet_names = [name for name in archive.namelist() if name.lower().endswith(".parquet")]
        if parquet_names:
            chosen = max(parquet_names, key=lambda name: archive.getinfo(name).file_size)
            with archive.open(chosen) as src, tempfile.NamedTemporaryFile(suffix=".parquet") as tmp:
                shutil.copyfileobj(src, tmp, length=1024 * 1024)
                tmp.flush()
                yield pd.read_parquet(tmp.name)
                return

        nested_csv_zips = [name for name in archive.namelist() if name.lower().endswith(".csv.zip")]
        if nested_csv_zips:
            chosen = max(nested_csv_zips, key=lambda name: archive.getinfo(name).file_size)
            with archive.open(chosen) as src, tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
                shutil.copyfileobj(src, tmp, length=1024 * 1024)
                tmp.flush()
                with zipfile.ZipFile(tmp.name) as nested:
                    csv_names = [name for name in nested.namelist() if name.lower().endswith(".csv")]
                    if not csv_names:
                        raise ValueError(f"Nested ZIP {chosen} contains no CSV files")
                    nested_chosen = max(csv_names, key=lambda name: nested.getinfo(name).file_size)
                    with nested.open(nested_chosen) as handle:
                        yield from pd.read_csv(handle, low_memory=False, chunksize=chunksize)
                        return

        raise ValueError("ZIP contains no CSV, parquet, or nested CSV ZIP files")


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    columns = list(df.columns)
    resolved = {name: find_column(columns, aliases) for name, aliases in ALIASES.items()}

    required = ["origin", "destination", "passengers", "fare"]
    missing = [name for name in required if resolved[name] is None]
    if missing:
        raise KeyError(
            "Could not identify required columns: "
            + ", ".join(missing)
            + f". Available columns include: {columns[:40]}"
        )

    output = pd.DataFrame()
    for target, source in resolved.items():
        output[target] = df[source] if source is not None else pd.NA

    for col in ["passengers", "fare", "distance", "year", "month"]:
        output[col] = pd.to_numeric(output[col], errors="coerce").astype("float64")

    output["origin"] = output["origin"].astype("string").str.strip()
    output["destination"] = output["destination"].astype("string").str.strip()
    output["carrier"] = output["carrier"].astype("string").str.strip()

    output = output.dropna(subset=["origin", "destination", "passengers", "fare"])
    output = output[(output["passengers"] > 0) & (output["fare"] >= 0)]
    return output.reset_index(drop=True)


def resolve_inputs(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            files.extend(sorted(path.glob("*.csv")))
            files.extend(sorted(path.glob("*.zip")))
            continue
        files.append(path)

    if not files:
        raise ValueError("No .zip or .csv input files were found.")
    return files


def build_site_market(row: pd.Series) -> dict[str, int | float | str | None]:
    avg_fare = float(row["avgFare"])
    passengers = float(row["passengers"])
    months = max(float(row.get("monthsObserved") or 1), 1)
    daily_demand = passengers / (months * 30)
    scenario_demand = int(max(60, min(260, round(daily_demand))))

    saver_demand = max(1, round(scenario_demand * 0.55))
    main_demand = max(1, round(scenario_demand * 0.32))
    flex_demand = max(1, scenario_demand - saver_demand - main_demand)

    return {
        "route": f"{row['origin']} \u2192 {row['destination']}",
        "origin": row["origin"],
        "destination": row["destination"],
        "avgFare": round(avg_fare),
        "passengers": round(passengers),
        "capacity": 180,
        "saverFare": round(avg_fare * 0.65),
        "saverDemand": saver_demand,
        "mainFare": round(avg_fare * 1.05),
        "mainDemand": main_demand,
        "flexFare": round(avg_fare * 1.85),
        "flexDemand": flex_demand,
        "records": int(row["records"]),
        "carriers": int(row["carriers"]),
        "monthsObserved": int(row["monthsObserved"]) if pd.notna(row["monthsObserved"]) else None,
    }


def update_route_stats(stats: dict, df: pd.DataFrame) -> None:
    if df.empty:
        return

    chunk = df.copy()
    chunk["fare_passengers"] = chunk["fare"] * chunk["passengers"]
    grouped = (
        chunk.groupby(["origin", "destination"], dropna=False)
        .agg(
            passengers=("passengers", "sum"),
            fare_passengers=("fare_passengers", "sum"),
            records=("passengers", "size"),
        )
        .reset_index()
    )

    for row in grouped.itertuples(index=False):
        key = (row.origin, row.destination)
        route = stats[key]
        route["passengers"] += float(row.passengers)
        route["fare_passengers"] += float(row.fare_passengers)
        route["records"] += int(row.records)

    carrier_rows = chunk[["origin", "destination", "carrier"]].dropna().drop_duplicates()
    for row in carrier_rows.itertuples(index=False):
        stats[(row.origin, row.destination)]["carriers"].add(row.carrier)

    month_rows = chunk[["origin", "destination", "year", "month"]].dropna().drop_duplicates()
    for row in month_rows.itertuples(index=False):
        stats[(row.origin, row.destination)]["months"].add((int(row.year), int(row.month)))


def write_route_summary(stats: dict, path: Path, top_n: int = 100) -> None:
    rows = []
    for (origin, destination), route in stats.items():
        passengers = route["passengers"]
        if passengers <= 0:
            continue
        rows.append(
            {
                "origin": origin,
                "destination": destination,
                "passengers": passengers,
                "avgFare": route["fare_passengers"] / passengers,
                "records": route["records"],
                "carriers": len(route["carriers"]),
                "monthsObserved": len(route["months"]),
            }
        )

    rows.sort(key=lambda row: row["passengers"], reverse=True)
    site_markets = [build_site_market(row) for row in rows[:top_n]]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(site_markets, indent=2), encoding="utf-8")


def route_stats_factory() -> dict:
    return {
        "passengers": 0.0,
        "fare_passengers": 0.0,
        "records": 0,
        "carriers": set(),
        "months": set(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, default=Path("data/processed/markets.parquet"))
    parser.add_argument("--site-summary", type=Path, default=Path("site/data/market_summary.json"))
    parser.add_argument("--top-routes", type=int, default=100)
    parser.add_argument("--chunksize", type=int, default=100_000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.chunksize < 1:
        raise ValueError("--chunksize must be at least 1")

    inputs = resolve_inputs(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()

    stats = defaultdict(route_stats_factory)
    writer = None
    rows = 0
    chunks = 0

    try:
        for path in inputs:
            print(f"Reading {path}")
            for raw_chunk in iter_input_chunks(path, args.chunksize):
                clean = normalize(raw_chunk)
                if clean.empty:
                    continue

                table = pa.Table.from_pandas(clean, schema=NORMALIZED_SCHEMA, preserve_index=False)
                if writer is None:
                    writer = pq.ParquetWriter(args.output, NORMALIZED_SCHEMA)
                writer.write_table(table)

                update_route_stats(stats, clean)
                rows += len(clean)
                chunks += 1
                print(f"  processed {rows:,} rows", flush=True)
    finally:
        if writer is not None:
            writer.close()

    if rows == 0:
        raise ValueError("No valid rows were found in the input files.")

    write_route_summary(stats, args.site_summary, args.top_routes)

    print(f"Files: {len(inputs):,}")
    print(f"Chunks: {chunks:,}")
    print(f"Rows: {rows:,}")
    print(f"Wrote {args.output}")
    print(f"Wrote {args.site_summary}")


if __name__ == "__main__":
    main()
