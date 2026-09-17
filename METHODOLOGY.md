# AeroYield Methodology

This document defines the mathematical and simulation assumptions behind AeroYield. The website leads with business outcomes; this file records the model boundary, information structure, and experiment design needed to reproduce and critique the results.

## 1. Decision problem

AeroYield models one economy cabin on one flight with physical capacity \(C\). Booking requests arrive before departure. Each request belongs to a modeled fare group \(k\), has fare \(f_k\), and can request one or more seats.

The airline must decide sequentially whether to accept or reject each request before future realized requests, cancellations, and no-shows are known. The experiment compares seat-control policies using **net ticket revenue**:

\[
\text{net revenue}
=
\text{gross ticket sales}
-
\text{cancellation refunds}
-
\text{denied-boarding refunds}
-
\text{denied-boarding compensation}.
\]

The current product is still a single-flight model. It does not model connecting itineraries, network displacement costs, competitor response, or airline-specific fare rules.

## 2. Market-data layer

The data pipeline normalizes BTS DB1C Market files into:

- origin
- destination
- reporting carrier
- passenger weight
- fare
- market distance
- year
- month

Route-level average fare is passenger-weighted. When distance is available, AeroYield computes passenger-weighted route distance and yield from the same distance-covered observations. For observation \(i\) with fare \(f_i\), passenger weight \(p_i\), and market distance \(d_i\),

\[
\text{average distance}
=
\frac{\sum_i d_i p_i}{\sum_i p_i},
\]

and

\[
\text{yield per passenger-mile}
=
\frac{\sum_i f_i p_i}{\sum_i d_i p_i}.
\]

Rows without a valid positive distance are excluded from both the yield numerator and denominator. Carrier share is computed from passenger weights among observations with a reporting-carrier identifier.

`average fare × observed passengers` is labeled **estimated market value**. It is a descriptive market-size proxy, not reported airline revenue.

DB1C does **not** provide the booking date, days-before-departure, realized booking class, cancellation history, or no-show outcome used by the simulation. Those elements are modeled assumptions.

## 3. Modeled fare groups and baseline demand

The route summary maps each observed route-average fare into three transparent experiment groups:

- Saver: lower fare / earlier-booking demand
- Main: middle fare / broad demand
- Flex: higher fare / later-booking demand

These are modeling inputs, not observed DB1C booking classes.

The processor derives baseline fare levels as fixed multiples of route-average fare and derives a bounded single-flight demand scenario from observed route traffic. The website can scale all three expected demands together.

The resulting baseline is a **forecast**, not the realized demand process used to score the policies.

## 4. Baseline booking forecast

The booking horizon runs from D-180 through departure. AeroYield uses four request opportunities per day:

\[
181 \times 4 = 724
\]

discrete periods.

For forecast class \(k\), a nonnegative booking-profile weight \(w_{t,k}\) is assigned to each period. The baseline forecast probability is

\[
\hat p_{t,k}
=
\mu_k
\frac{w_{t,k}}{\sum_s w_{s,k}},
\]

where \(\mu_k\) is the modeled expected seat demand for class \(k\).

The qualitative forecast profiles are:

- Saver demand is strongest earlier and declines toward departure.
- Main demand is comparatively stable.
- Flex demand is concentrated later.

EMSR-b and the dynamic program are built from this baseline forecast. They are **not** rebuilt using the realized perturbations in each Monte Carlo replication.

## 5. Realized demand process

Each replication creates a different realized demand process that is hidden from the deployable policies.

### 5.1 Market-wide and class-specific demand error

AeroYield draws both:

- a market-wide demand shock shared across fare groups, and
- class-specific demand error.

These are combined into a positive demand multiplier for each fare group. This creates correlated forecast miss: a strong market tends to affect more than one class instead of giving each class an unrelated error.

The user-facing **Demand uncertainty** control changes the scale of these perturbations. It is a scenario parameter, not an empirically calibrated airline forecast-error estimate.

### 5.2 Booking-timing error

The realized booking curve also receives:

- a shared market timing shift, and
- class-specific timing error.

The user-facing **Booking-timing uncertainty** control bounds the size of these shifts.

### 5.3 Persistent day-to-day booking noise

Real booking activity often arrives in bursts rather than as independent daily spikes. AeroYield therefore uses correlated day-level multiplicative noise. A high or low booking day tends to influence nearby days.

The perturbed class profile is renormalized to the replication's class-demand target before requests are generated.

### 5.4 Party arrivals

The baseline demand values are interpreted as expected **seat demand**. Because one request can contain multiple seats, the realized party-arrival rate is divided by the expected party size so adding groups does not mechanically inflate expected seat demand.

The current party-size distribution is:

| Party size | Probability |
| ---: | ---: |
| 1 | 84% |
| 2 | 12% |
| 3 | 3% |
| 4 | 1% |

These probabilities are transparent modeling assumptions, not DB1C observations.

## 6. Cancellations and no-shows

A booking can experience one of three final states:

1. remain active and show up,
2. cancel before departure, or
3. remain active but no-show at departure.

### Cancellations

The user specifies a base cancellation rate. Earlier bookings are assigned a higher event-level cancellation probability because they have more time before departure.

Conditional on cancellation, the cancellation time is sampled within the remaining booking horizon and is skewed toward later dates rather than being uniformly distributed.

When an accepted booking cancels:

- its seats immediately return to booking inventory;
- the chosen refund fraction is subtracted from net revenue.

### No-shows

No-shows are not revealed until departure. In the current model:

- the booking continues to occupy booking inventory until departure;
- the passenger does not consume a physical seat at departure;
- the ticket revenue is retained;
- no no-show refund is applied.

The no-show rate is a user-controlled scenario assumption.

## 7. Controlled overbooking and denied boarding

Let the physical aircraft capacity be \(C\). If the user selects an overbooking fraction \(\alpha\), the booking limit is

\[
B
=
C+\operatorname{round}(\alpha C).
\]

Open Sales, EMSR-b, and the DP may accept bookings up to this booking limit.

At departure, cancellations have already released inventory and no-shows are removed from the set of passengers attempting to board. If remaining show-ups exceed physical capacity, the excess is denied boarding.

For each denied-boarded seat, the model currently applies:

- a full ticket refund, and
- a fixed $400 modeled compensation cost.

The $400 value is a transparent scenario assumption, not a claim about a specific airline or regulatory payment.

## 8. Random-number design and common random numbers

Every replication is deterministic for a given seed.

AeroYield uses separate seeded random-number streams for:

- realized demand/timing perturbations,
- booking arrivals,
- party sizes, and
- cancellations/no-shows.

This separation matters. For example, changing the cancellation-rate slider does not silently redraw the underlying booking arrivals.

Within one replication, every policy receives the **same realized booking requests, party sizes, cancellation outcomes, and no-show outcomes**. This common-random-number design reduces noise in policy comparisons.

The browser and Python implementations use the same 32-bit linear congruential generator constants:

\[
x_{n+1}
=
(1664525x_n+1013904223)
\bmod 2^{32}.
\]

## 9. Open Sales baseline

Open Sales accepts every party that fits under the current booking limit.

It has no demand-protection rule. Cancellations can reopen booking capacity later, and no-shows are unknown until departure.

Open Sales is useful as a transparent baseline for revenue lift.

## 10. EMSR-b

EMSR-b sorts fare groups from highest to lowest fare. At each fare boundary, higher-fare forecast demand is aggregated into one demand distribution and represented by a demand-weighted average higher fare.

AeroYield assumes independent Poisson total forecast demand by fare group. For an aggregate of higher-fare classes,

\[
\mu=\sum_k \mu_k,
\qquad
\sigma^2=\mu.
\]

For lower fare \(f_L\) and aggregated higher fare \(\bar f_H\), the EMSR critical probability is

\[
P(D_H \le y)
=
1-\frac{f_L}{\bar f_H}.
\]

The implementation uses a normal approximation to obtain an integer protection level.

For a multi-seat request, AeroYield accepts the entire party only if it fits without crossing the applicable protection level.

### Guarantee

EMSR-b is a heuristic. It is not generally optimal, and the richer realized simulation intentionally violates some of its planning assumptions.

## 11. Finite-horizon dynamic program

The DP is solved for the **baseline one-seat forecast model** with state

\[
(t,c),
\]

where \(t\) is booking period and \(c\) is remaining booking capacity.

Let \(\hat p_{t,k}\) be the baseline forecast probability of class \(k\) in period \(t\), with

\[
\hat p_{t,0}
=
1-\sum_k \hat p_{t,k}.
\]

The Bellman recursion is

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

The one-seat bid price is

\[
b_t(c)
=
V_{t+1}(c)-V_{t+1}(c-1).
\]

For a realized request of \(m\) seats, AeroYield approximates the opportunity cost by summing the next \(m\) forecast seat bid prices and accepts the entire request when the party's total fare clears that cost.

### Guarantee

The DP is exact for its internal baseline forecast model: one-seat requests, known forecast probabilities, and no attrition inside the Bellman state.

It is **not** exact for the richer realized simulation containing forecast error, groups, cancellations, no-shows, and overbooking. That mismatch is intentional: the experiment asks how a strong forecast-based policy behaves when reality differs from its model.

## 12. Oracle upper bound

The oracle sees the complete realized future:

- all booking requests,
- party sizes,
- cancellations, and
- no-shows.

Cancelled and no-show bookings do not consume final physical capacity. For the remaining show-up requests, the oracle solves a 0/1 knapsack problem over physical seat capacity.

The oracle also relaxes transient booking-limit constraints. Therefore it is intentionally **unattainable** and should be interpreted only as a perfect-information upper bound.

It is not presented as a deployable policy.

## 13. Evaluation metrics

For every policy and replication, AeroYield records:

- **Net revenue:** gross ticket sales minus modeled refunds and denied-boarding compensation.
- **Gross ticket sales:** fare collected when bookings are accepted.
- **Accepted seats:** seats sold across accepted parties.
- **Boarded passengers:** show-ups that receive physical seats.
- **Load factor:** boarded passengers divided by physical capacity.
- **Rejected seats / spill:** requested seats not accepted.
- **Cancelled seats:** accepted seats later cancelled.
- **No-show seats:** active bookings that do not show at departure.
- **Empty seats / spoilage:** physical seats unused at departure.
- **Denied boarding:** show-up seats above physical capacity after overbooking.
- **Average sold fare:** gross ticket sales divided by accepted seats.
- **Regret:** oracle net revenue minus policy net revenue on the same realization.

Across replications the dashboard reports mean values and the 10th, 50th, and 90th percentiles of net revenue.

## 14. Reproducibility and testing

The Python and browser implementations mirror the same simulation concepts.

CI tests include:

- optimizer feasibility and EMSR protection behavior;
- exact DP behavior on toy forecast models;
- seeded demand perturbation reproducibility;
- party-size and attrition generation;
- separation of arrival RNG from attrition RNG;
- no-show capacity accounting;
- oracle upper-bound behavior;
- data enrichment and processing;
- static-site wiring and JavaScript syntax.

## 15. Scope and limitations

AeroYield intentionally remains a transparent single-flight portfolio model. Important limitations include:

- booking curves and forecast-error distributions are modeled rather than calibrated from reservation-system data;
- cancellation, no-show, party-size, refund, and denied-boarding assumptions are scenario inputs;
- the booking horizon allows at most one party request per discrete opportunity;
- the DP does not optimize cancellations, no-shows, or overbooking jointly;
- overbooking is a user-selected booking limit rather than an optimized control;
- there is no network revenue management or connecting-itinerary displacement cost;
- there is no demand response to price or competitor behavior.

Natural extensions include calibrated booking curves, empirical cancellation/no-show models, optimized overbooking, richer demand forecasting, and network revenue management.
