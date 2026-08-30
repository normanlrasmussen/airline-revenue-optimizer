#!/usr/bin/env python3
"""Normalize a BTS DB1C Market ZIP/CSV into a compact analysis table."""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path

import pandas as pd

ALIASES = {
    "origin": ["Origin", "MktOrigin", "MarketOrigin", "OriginAirport", "OriginAirportID"],
    "destination": ["Dest", "Destination", "MktDest", "MarketDestination", "DestAirport"],
    "carrier": ["RpCarrier", "ReportingCarrier", "TkCarrier", "Carrier"],
    "passengers": ["Passengers", "MktPassengers", "PassengerCount", "Pax"],
    "fare": ["MktFare", "MarketFare", "Fare", "ItinFare", "ProratedMarketFare"],
    "distance": ["MktDistance", "MarketDistance", "Distance", "MilesFlown"],
    "year": ["RpYear", "Year", "ReportingYear"],
    "month": ["RpMonth", "Month", "ReportingMonth"],
}


def canonical(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def find_column(columns: list[str], aliases: list[str]) -> str | None:
    lookup = {canonical(c): c for c in columns}
    for alias in aliases:
        if canonical(alias) in lookup:
            return lookup[canonical(alias)]
    return None


def read_input(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        return pd.read_csv(path, low_memory=False)

    if path.suffix.lower() != ".zip":
        raise ValueError("Input must be a .zip or .csv file")

    with zipfile.ZipFile(path) as archive:
        csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if not csv_names:
            raise ValueError("ZIP contains no CSV files")
        chosen = max(csv_names, key=lambda name: archive.getinfo(name).file_size)
        with archive.open(chosen) as handle:
            return pd.read_csv(handle, low_memory=False)


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
        output[col] = pd.to_numeric(output[col], errors="coerce")

    output["origin"] = output["origin"].astype("string").str.strip()
    output["destination"] = output["destination"].astype("string").str.strip()
    output["carrier"] = output["carrier"].astype("string").str.strip()

    output = output.dropna(subset=["origin", "destination", "passengers", "fare"])
    output = output[(output["passengers"] > 0) & (output["fare"] >= 0)]
    return output.reset_index(drop=True)


def write_route_summary(df: pd.DataFrame, path: Path, top_n: int = 100) -> None:
    grouped = (
        df.groupby(["origin", "destination"], dropna=False)
        .apply(
            lambda g: pd.Series(
                {
                    "passengers": float(g["passengers"].sum()),
                    "weighted_avg_fare": float(
                        (g["fare"] * g["passengers"]).sum() / g["passengers"].sum()
                    ),
                    "records": int(len(g)),
                    "carriers": int(g["carrier"].nunique(dropna=True)),
                }
            ),
            include_groups=False,
        )
        .reset_index()
        .sort_values("passengers", ascending=False)
        .head(top_n)
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(grouped.to_dict(orient="records"), indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/processed/markets.parquet"))
    parser.add_argument("--site-summary", type=Path, default=Path("site/data/market_summary.json"))
    parser.add_argument("--top-routes", type=int, default=100)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    raw = read_input(args.input)
    clean = normalize(raw)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    clean.to_parquet(args.output, index=False)
    write_route_summary(clean, args.site_summary, args.top_routes)

    print(f"Rows: {len(clean):,}")
    print(f"Wrote {args.output}")
    print(f"Wrote {args.site_summary}")


if __name__ == "__main__":
    main()
