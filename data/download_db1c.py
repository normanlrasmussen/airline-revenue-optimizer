#!/usr/bin/env python3
"""Discover and download official BTS DB1C (OD40) monthly files.

This script intentionally discovers the current download URLs from the official BTS
pages instead of hard-coding publication-date-stamped Azure Blob URLs.
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

PAGES = {
    "market": "https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data-market",
    "ticket": "https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data-ticket",
    "coupon": "https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data-coupon",
    "segment": "https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data-segment",
    "product": "https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data-product",
}

ZIP_PATTERN = re.compile(r"DB1C\.(?P<kind>[A-Z_]+)\.(?P<yyyymm>\d{6})\.[^.]+\.zip$", re.I)


@dataclass(frozen=True, order=True)
class Download:
    year: int
    month: int
    dataset: str
    url: str

    @property
    def yyyymm(self) -> str:
        return f"{self.year:04d}{self.month:02d}"


def discover(dataset: str, timeout: int = 30) -> list[Download]:
    """Return available DB1C monthly downloads from the official BTS page."""
    page_url = PAGES[dataset]
    response = requests.get(
        page_url,
        timeout=timeout,
        headers={"User-Agent": "AeroYield/0.1 (portfolio research project)"},
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    found: list[Download] = []
    for anchor in soup.find_all("a", href=True):
        href = urljoin(page_url, anchor["href"])
        filename = href.rsplit("/", 1)[-1]
        match = ZIP_PATTERN.search(filename)
        if not match:
            continue

        yyyymm = match.group("yyyymm")
        found.append(
            Download(
                year=int(yyyymm[:4]),
                month=int(yyyymm[4:]),
                dataset=dataset,
                url=href,
            )
        )

    # Deduplicate while preserving newest-first order.
    unique = {(d.year, d.month, d.url): d for d in found}
    return sorted(unique.values(), reverse=True)


def select_download(
    downloads: Iterable[Download], *, year: int | None, month: int | None, latest: bool
) -> Download:
    available = list(downloads)
    if not available:
        raise RuntimeError("No DB1C ZIP links were discovered on the BTS page.")

    if latest:
        return max(available)

    if year is None or month is None:
        raise ValueError("Provide --latest or both --year and --month.")

    matches = [d for d in available if d.year == year and d.month == month]
    if not matches:
        months = ", ".join(sorted({d.yyyymm for d in available}, reverse=True)[:12])
        raise ValueError(f"{year:04d}-{month:02d} is unavailable. Recent months: {months}")
    return matches[0]


def download_file(item: Download, output_dir: Path, timeout: int = 120) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / item.url.rsplit("/", 1)[-1]

    with requests.get(
        item.url,
        stream=True,
        timeout=timeout,
        headers={"User-Agent": "AeroYield/0.1 (portfolio research project)"},
    ) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length", 0))
        downloaded = 0
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                handle.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = 100 * downloaded / total
                    print(f"\rDownloading {destination.name}: {pct:5.1f}%", end="", flush=True)
    print()
    return destination


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=sorted(PAGES), default="market")
    parser.add_argument("--year", type=int)
    parser.add_argument("--month", type=int, choices=range(1, 13))
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--list", action="store_true", help="List discovered files without downloading.")
    parser.add_argument("--output-dir", type=Path, default=Path("data/raw"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    downloads = discover(args.dataset)

    if args.list:
        for item in downloads:
            print(f"{item.year:04d}-{item.month:02d}  {item.url}")
        return 0

    try:
        item = select_download(downloads, year=args.year, month=args.month, latest=args.latest)
    except (ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    path = download_file(item, args.output_dir)
    print(f"Saved {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
