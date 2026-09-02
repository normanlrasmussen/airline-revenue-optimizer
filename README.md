# AeroYield — Airline Revenue Optimizer

A portfolio-grade airline revenue management project built around the U.S. Department of Transportation Bureau of Transportation Statistics (BTS) Origin & Destination Survey.

The project is intentionally split into three layers:

1. **Data** — download and prepare DB1C / OD40 fare and itinerary data.
2. **Optimization** — a deliberately simple seat-allocation model that is easy to replace with EMSR, bid-price control, stochastic dynamic programming, or network revenue management.
3. **Decision product** — a static GitHub Pages dashboard that explains the market, runs an interactive seat-allocation scenario, and quantifies modeled revenue lift.

## Why DB1C / OD40?

Beginning in July 2025, BTS replaced the quarterly 10% DB1B sample with monthly DB1C (OD40), a 40% sample of airline tickets. The public files include ticket, market, coupon, and segment information such as fares, passenger counts, origins, destinations, and carriers.

Official source: https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data

## Repository layout

```text
.
├── data/
│   ├── download_db1c.py      # discover/download official monthly BTS ZIP files
│   └── process_db1c.py       # normalize a DB1C market file for analysis/web use
├── optimization/
│   └── seat_optimizer.py     # intentionally simple deterministic integer model
├── tests/
│   └── test_seat_optimizer.py
├── site/
│   ├── index.html            # GitHub Pages MVP
│   ├── styles.css
│   ├── app.js
│   └── data/demo_markets.json
├── .github/workflows/pages.yml
└── requirements.txt
```

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
pytest
```

### 1. Download DB1C data

Download the newest Market file:

```bash
python data/download_db1c.py --dataset market --latest
```

Download a specific month:

```bash
python data/download_db1c.py --dataset market --year 2026 --month 5
python data/download_db1c.py --dataset ticket --year 2026 --month 5
```

Files are written to `data/raw/` and are ignored by Git.

### 2. Prepare a market-level file

```bash
python data/process_db1c.py \
  --input data/raw/<downloaded-market-file>.zip \
  --output data/processed/markets.parquet
```

Prepare every Market ZIP/CSV in `data/raw/` as one combined website extract:

```bash
python data/process_db1c.py \
  --input data/raw \
  --output data/processed/markets.parquet \
  --site-summary site/data/market_summary.json \
  --chunksize 100000
```

If the processor still uses too much memory, lower `--chunksize` to `50000` or `25000`.

The processor is defensive about column naming because BTS public schemas can evolve. It searches common DB1C field aliases and emits a normalized table with:

- `origin`
- `destination`
- `carrier`
- `passengers`
- `fare`
- `distance`
- `year`
- `month`

### 3. Run the starter optimizer

```bash
python optimization/seat_optimizer.py
```

The MVP model solves a small deterministic integer seat-allocation problem:

\[
\max \sum_k f_k x_k
\]

subject to

\[
\sum_k x_k \le C, \qquad 0 \le x_k \le d_k, \qquad x_k \in \mathbb{Z}.
\]

It is deliberately basic. The goal is to make the boundary clean so the optimization can evolve independently of the website and data pipeline.

Good next steps:

- Littlewood's rule for two fare classes
- EMSR-a / EMSR-b protection levels
- booking-limit controls
- demand distributions instead of point forecasts
- overbooking with denied-boarding cost
- bid-price control
- connecting-passenger / network revenue management
- dynamic programming or approximate dynamic programming

## GitHub Pages

The included workflow publishes the `site/` directory through GitHub Pages on pushes to `main`.

After creating the repository, enable **Settings → Pages → Source: GitHub Actions** once. Subsequent pushes to `main` deploy automatically.

## Design system

The MVP uses a restrained aviation/finance palette:

- Deep navy: `#0B1F33`
- Slate: `#52606D`
- Teal: `#1F7A8C`
- Warm gold: `#C7922B`
- Cloud: `#F5F7FA`
- White: `#FFFFFF`

## Data note

The dashboard ships with clearly labeled **demo scenarios** so the static site works immediately. The next development step is to generate `site/data/market_summary.json` from downloaded DB1C data and switch the UI to the real processed output.
