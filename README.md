# AeroYield — Airline Revenue Optimizer

[![CI](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/ci.yml)
[![Deploy GitHub Pages](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/pages.yml/badge.svg)](https://github.com/normanlrasmussen/airline-revenue-optimizer/actions/workflows/pages.yml)

**AeroYield is an interactive operations-research project that uses U.S. airline market data, stochastic booking simulation, and revenue-management optimization to quantify the value of better seat-control decisions.**

**[Live Demo](https://normanlrasmussen.github.io/airline-revenue-optimizer/)** · **[Revenue Optimizer](https://normanlrasmussen.github.io/airline-revenue-optimizer/optimizer.html)** · **[Methodology](METHODOLOGY.md)**

![AeroYield project overview](assets/aeroyield-overview.svg)

## Why it matters

An airline seat is **perishable inventory**: once the aircraft departs, an empty seat is worth zero. But selling every seat too early can also destroy value by displacing customers who arrive later and are willing to pay more.

AeroYield turns that trade-off into a sequential decision problem: **accept this booking now, or preserve the seat for uncertain future demand?** The project connects real market context to a deliberately noisy booking simulation, then compares forecast-based seat-control policies on the same realized customer streams.

## Portfolio highlights

- **Data engineering:** processes U.S. DOT DB1C market data into route-level fare, passenger, distance, yield, carrier-share, and trend metrics.
- **Operations research:** compares Open Sales, EMSR-b, and a finite-horizon dynamic program built from a baseline single-flight demand forecast.
- **Stochastic experimentation:** separates the forecast from the realized world using correlated demand shocks, booking-timing error, multi-seat parties, cancellations, no-shows, and controlled overbooking.
- **Decision support:** reports net revenue lift, load factor, spill, spoilage, cancellations, no-shows, denied boarding, regret, EMSR protection levels, and DP bid prices.
- **Reproducibility:** uses deterministic seeds, separate random streams, common random numbers across policies, automated tests, CI, and GitHub Pages deployment.

**Tech stack:** Python · Pandas · PyArrow · JavaScript · Dynamic Programming · Monte Carlo Simulation · GitHub Actions · GitHub Pages

## What the project does

The application follows one simple workflow:

**Observed DB1C market data → baseline demand forecast → noisy realized bookings → seat-control policy → net revenue comparison**

The product includes:

- **The Problem** — plain-language explanation of single-flight revenue management.
- **Market Data** — route screening, passenger/fare trends, distance-normalized yield, and carrier-share context.
- **Route Detail** — commercial drill-down for one directional market before changing controls.
- **Revenue Optimizer** — a simulation and decision workbench that compares Open Sales, EMSR-b, and dynamic programming across common realized booking streams.

The old `twin.html` Booking Simulator URL is retained only as a compatibility redirect to `optimizer.html`; there is no separate simulator product surface.

## Revenue-management methods

AeroYield compares four levels of information and sophistication:

| Method | What it does | Information available |
| --- | --- | --- |
| **Open Sales** | Accept every party while it fits under the booking limit. | Current inventory only |
| **EMSR-b** | Protect seats from lower fares using aggregated higher-fare forecast demand. | Baseline demand forecast |
| **Finite-horizon DP** | Use time-varying forecast seat opportunity costs. | Baseline period-by-period forecast |
| **Oracle** | Choose with knowledge of realized requests, cancellations, and no-shows. | Perfect future information; benchmark only |

The DP is solved exactly for its internal baseline one-seat forecast model. Its policy is then applied to a richer realized simulation that can contain forecast error, multi-seat requests, cancellations, no-shows, and overbooking. It is therefore **not** claimed to be optimal for the realized simulation or for a real airline.

The DP uses state `(booking period, remaining booking capacity)` and Bellman recursion

\[
V_t(c)
=
\hat p_{t,0}V_{t+1}(c)
+
\sum_k
\hat p_{t,k}
\max
\left\{
V_{t+1}(c),
f_k+V_{t+1}(c-1)
\right\}.
\]

The implied one-seat bid price is

\[
V_{t+1}(c)-V_{t+1}(c-1).
\]

For a multi-seat request, AeroYield approximates the opportunity cost by summing the relevant seat bid prices.

See [METHODOLOGY.md](METHODOLOGY.md) for the simulation design, information boundary, assumptions, guarantees, and limitations.

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
- Saver / Main / Flex baseline expected demand
- booking-arrival timing profiles
- forecast error and timing perturbations
- party sizes
- cancellations and refund fraction
- no-shows
- overbooking limit
- denied-boarding compensation

DB1C does **not** provide the purchase date, days-before-departure, realized booking class, cancellation history, or no-show behavior used by the simulation. Simulation results are not airline accounting results.

## Stochastic simulation

The booking horizon contains four request opportunities per day over D-180 through departure.

Each experiment starts with a baseline forecast. Every Monte Carlo replication then creates a different hidden realized world using:

- a market-wide demand shock shared across fare groups;
- class-specific demand forecast error;
- market-wide and class-specific booking-timing shifts;
- persistent day-to-day booking noise rather than independent daily spikes;
- random parties of 1–4 seats;
- lead-time-dependent cancellations;
- departure no-shows;
- user-selected cancellation refunds and overbooking.

The deployable policies continue to use the **baseline forecast**. They do not receive the realized demand probabilities, future cancellations, or future no-show outcomes.

Separate deterministic random streams are used for demand perturbations, request arrivals, party sizes, and attrition. This means changing a cancellation assumption does not silently redraw the underlying customer arrival stream.

Within each replication, Open Sales, EMSR-b, DP, and the oracle are evaluated against the same realized requests and customer outcomes. This common-random-number design reduces comparison noise.

The Revenue Optimizer reports:

- average net revenue and revenue lift vs. Open Sales
- 10th / 50th / 90th percentile net revenue
- boarded load factor
- rejected seats
- cancelled seats
- no-show seats
- empty seats
- denied boarding
- average sold fare
- regret vs. the oracle

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

The processor writes the normalized parquet, generates the site summary, and automatically enriches it when distance and carrier fields are available. The site displays unavailable values rather than inventing estimates.

## Repository layout

```text
.
├── data/
│   ├── download_db1c.py
│   ├── process_db1c.py
│   └── enrich_summary.py
├── optimization/
│   ├── seat_optimizer.py
│   ├── revenue_management.py
│   └── simulation.py                  # Python simulation mirror
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
│   ├── optimizer.html / app.js
│   ├── twin.html                      # legacy redirect
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

Tests cover optimizer feasibility, EMSR protection behavior, DP Bellman decisions on toy forecast models, seeded demand perturbations, party-size and attrition generation, RNG-stream separation, no-show accounting, oracle upper-bound behavior, enrichment calculations, the data-build pipeline, and static-site wiring.

## Current scope

The portfolio scope is intentionally **single-flight seat inventory control**. The goal is to make the data/model/decision boundary easy to understand and mathematically defensible rather than hide assumptions behind a large prototype.

The simulation now includes imperfect demand forecasts, multi-seat requests, cancellations, no-shows, refunds, overbooking, and denied-boarding costs. Those elements are still **scenario models**, not empirically calibrated airline behavior.

Explicit future work includes:

- network revenue management and connecting itineraries
- optimized overbooking rather than a user-selected booking limit
- airline-specific fare-family and availability data
- empirically calibrated booking, cancellation, and no-show models
- richer demand forecasting / machine-learning calibration
- competitive price-response models
- approximate dynamic programming for larger network state spaces

## Data source

The data pipeline is designed for the U.S. Department of Transportation Bureau of Transportation Statistics Origin & Destination Survey (DB1C / OD40):

https://www.bts.gov/topics/airlines-and-airports/origin-and-destination-survey-data

GitHub Pages deploys the `site/` directory automatically after changes reach `main`.
