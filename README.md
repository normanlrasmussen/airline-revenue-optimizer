# AeroYield — Airline Revenue Optimizer

[![CI](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/ci.yml)
[![Deploy GitHub Pages](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/pages.yml/badge.svg)](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/pages.yml)

**AeroYield is an interactive operations-research project that uses U.S. airline market data, stochastic booking simulation, and revenue-management optimization to quantify the value of better seat-control decisions.**

**[Live Demo](https://normanlrasmussen.github.io/airline-revenue-optimizer/)** · **[Revenue Optimizer](https://normanlrasmussen.github.io/airline-revenue-optimizer/optimizer.html)** · **[Methodology](METHODOLOGY.md)**

![AeroYield project overview](assets/aeroyield-overview.svg)

## Why it matters

An airline seat is **perishable inventory**: once the aircraft departs, an empty seat is worth zero. But selling every seat too early can also destroy value by displacing customers who arrive later and are willing to pay more.

AeroYield turns that trade-off into a sequential decision problem: **accept this booking now, or preserve the seat for uncertain future demand?** The project connects real market context to stochastic simulation and optimization, then exposes the resulting revenue and operating trade-offs in an interactive decision-support application.

## Portfolio highlights

- **Data engineering:** processes U.S. DOT DB1C market data into route-level fare, passenger, distance, yield, carrier-share, and trend metrics.
- **Operations research:** compares Open Sales, EMSR-b, and an exact finite-horizon dynamic program for AeroYield's stated single-flight model.
- **Stochastic experimentation:** uses deterministic seeds and common random numbers so competing policies face identical simulated booking streams.
- **Decision support:** reports revenue lift, load factor, spill, spoilage, accepted fare, regret, EMSR protection levels, and DP bid prices in a deployed web application.

**Tech stack:** Python · Pandas · PyArrow · JavaScript · Dynamic Programming · Monte Carlo Simulation · GitHub Actions · GitHub Pages

## What the project does

The GitHub Pages application follows one simple workflow:

**Observed DB1C market data → modeled booking demand → seeded simulation → seat-control policy → revenue comparison**

The product includes:

- **The Problem** — plain-language explanation of single-flight revenue management.
- **Market Data** — route screening, passenger/fare trends, distance-normalized yield, and carrier-share context.
- **Route Detail** — commercial drill-down for one directional market before changing controls.
- **Revenue Optimizer** — the single experiment and decision workbench. It runs common-random-number Monte Carlo simulation, compares Open Sales / EMSR-b / dynamic programming on identical booking streams, and reports expected revenue lift, load factor, rejected demand, empty seats, average accepted fare, regret, EMSR protection levels, and DP bid prices.

The old `twin.html` Booking Simulator URL is retained only as a compatibility redirect to `optimizer.html`; there is no separate simulator product surface.

## Revenue-management methods

AeroYield compares four levels of information and sophistication:

| Method | What it does | Status |
| --- | --- | --- |
| **Open Sales** | Accept every request while capacity remains. | Baseline |
| **EMSR-b** | Protect seats from lower fares using aggregated higher-fare demand. | Interpretable heuristic |
| **Finite-horizon DP** | Accept when fare is at least the expected future value of the seat. | Exact for AeroYield's discretized model |
| **Clairvoyant** | After seeing all realized demand, fill seats with the highest fares. | Perfect-information upper bound only |

The dynamic program uses state `(booking period, remaining seats)` and Bellman recursion

\[
V_t(c)=p_0V_{t+1}(c)+\sum_k p_{t,k}\max\left\{V_{t+1}(c),\; f_k+V_{t+1}(c-1)\right\}.
\]

The implied bid price of one seat is

\[
V_{t+1}(c)-V_{t+1}(c-1).
\]

A request is accepted when its fare is at least that opportunity cost.

See [METHODOLOGY.md](METHODOLOGY.md) for the simulation design, EMSR assumptions, guarantees, and limitations.

## Observed data vs. modeled assumptions

AeroYield deliberately keeps these separate.

**Observed / DB1C-derived when available**

- origin and destination
- passenger weight
- average fare
- reporting carrier
- market distance
- year and month

**Derived from observed data**

- passenger-weighted average fare
- estimated market value (`average fare × observed passengers`)
- yield per passenger-mile
- reporting-carrier passenger shares
- monthly network/route trends

**Modeled for experimentation**

- Saver / Main / Flex fare groups
- Saver / Main / Flex expected demand
- booking-arrival timing profiles
- future booking requests

Simulation results are **not airline accounting results** and the modeled fare groups are **not observed DB1C booking classes**.

## Reproducible simulation

The booking horizon contains four request opportunities per day over D-180 through departure. At most one request occurs in an opportunity. Class-specific arrival probabilities are normalized so expected total demand matches the selected route scenario.

Every replication uses a deterministic seed. Within that replication, Open Sales, EMSR-b, DP, and the clairvoyant benchmark all receive the **same booking stream**. This common-random-number design reduces comparison noise: policy differences are not caused by one policy receiving luckier simulated customers.

The Revenue Optimizer reports:

- average revenue and revenue lift vs. Open Sales
- 10th / 50th / 90th percentile revenue
- load factor
- rejected requests (spill)
- empty seats (spoilage)
- average accepted fare
- regret vs. clairvoyant revenue

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
pytest -q
```

To serve the static site locally:

```bash
python -m http.server 8000 --directory site
```

Then open `http://localhost:8000`.

## Build the market data

Download the newest BTS Market file:

```bash
python data/download_db1c.py --dataset market --latest
```

Or download the saved monthly market-file list used by this project:

```bash
python data/download_db1c.py \
  --url-file data/zips/zip_links.txt \
  --output-dir data/raw
```

Normalize all downloaded Market files, create the route summary, and automatically add distance/yield and carrier-share enrichment:

```bash
python data/process_db1c.py \
  --input data/raw \
  --output data/processed/markets.parquet \
  --site-summary site/data/market_summary.json \
  --chunksize 100000
```

The processor writes the normalized parquet, generates the site summary, and automatically enriches it when distance and carrier fields are available. The site gracefully displays unavailable values rather than inventing estimates.

## Repository layout

```text
.
├── data/
│   ├── download_db1c.py
│   ├── process_db1c.py
│   └── enrich_summary.py
├── optimization/
│   ├── seat_optimizer.py              # legacy deterministic allocation benchmark
│   ├── revenue_management.py          # Open / EMSR-b / DP / clairvoyant methods
│   └── simulation.py                  # seeded Python simulation mirror
├── tests/
│   ├── test_seat_optimizer.py
│   ├── test_revenue_management.py
│   ├── test_simulation.py
│   ├── test_enrich_summary.py
│   ├── test_process_db1c_pipeline.py
│   └── test_site_integrity.py
├── site/
│   ├── index.html
│   ├── market.html
│   ├── data.html / data.js
│   ├── route.html / route.js
│   ├── optimizer.html / app.js        # simulation + optimization workbench
│   ├── twin.html                      # legacy redirect to optimizer.html
│   ├── analytics.js
│   ├── rm.js
│   ├── simulation.js
│   └── data/
│       ├── market_summary.json
│       └── demo_markets.json
└── .github/workflows/
    ├── ci.yml
    └── pages.yml
```

## Tests and CI

CI runs on every pull request and on pushes to `main`:

```bash
pytest -q
python -m compileall -q data optimization tests
for file in site/*.js; do node --check "$file"; done
```

Tests cover optimizer feasibility, EMSR protection behavior, DP Bellman decisions on exact toy cases, seeded simulation reproducibility, clairvoyant upper-bound behavior, enrichment calculations, the data-build pipeline, and static-site wiring.

## Current scope

The finished portfolio scope is intentionally **single-flight seat inventory control**. The goal is to make the data/model/decision boundary easy to understand and mathematically defensible rather than hide complexity behind a large prototype.

Explicit future work—not required for the current product—is:

- network revenue management and connecting itineraries
- overbooking, cancellations, and no-shows
- airline-specific fare-family and availability data
- demand forecasting / machine-learning calibration
- competitive price-response models
- approximate dynamic programming for larger network state spaces

## Data source

The data pipeline is designed for the U.S. Department of Transportation Bureau of Transportation Statistics Origin & Destination Survey (DB1C / OD40):

https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data

GitHub Pages deploys the `site/` directory automatically after changes reach `main`.
