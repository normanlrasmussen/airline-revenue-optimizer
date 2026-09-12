# AeroYield Methodology

This document defines the mathematical and simulation assumptions behind the AeroYield decision product. The website intentionally explains the business outcome first; this file records the technical details needed to reproduce and critique the experiment.

## 1. Decision problem

AeroYield models one economy cabin on one flight with capacity `C`. Booking requests arrive before departure. Each request belongs to a modeled fare group `k` with fare `f_k` and consumes one seat if accepted.

The airline must decide sequentially whether to accept or reject a request before future requests are known. The objective is to maximize expected ticket revenue.

The initial model excludes cancellations, no-shows, overbooking, group requests, network connections, and competitive price response. Those are deliberate scope boundaries, not hidden assumptions.

## 2. Market-data layer

The pipeline normalizes BTS DB1C Market files into:

- origin
- destination
- reporting carrier
- passenger weight
- fare
- market distance
- year
- month

Route-level average fare is passenger-weighted. When distance is available, route distance is also passenger-weighted and yield is

\[
\text{yield} = \frac{\text{average fare}}{\text{average distance}}.
\]

Carrier share is computed from passenger weights among observations with a reporting-carrier identifier. The dashboard surfaces carrier-data coverage so a partial carrier field is not presented as complete market share.

`average fare × observed passengers` is labeled **estimated market value**. It is a screening metric, not reported airline revenue.

## 3. Modeled fare groups

The current route summary maps each observed route-average fare into three transparent experiment groups:

- Saver: lower fare / earlier-booking demand
- Main: middle fare / broad demand
- Flex: higher fare / later-booking demand

These are modeling inputs. They are not claimed to be observed DB1C fare classes.

The current processor derives baseline fare levels as fixed multiples of route-average fare and derives a bounded scenario demand from observed traffic. The website can scale all three expected demands together to test lower- or higher-demand scenarios.

## 4. Booking-arrival model

The horizon runs from D-180 through departure. AeroYield uses four request opportunities per day, giving

\[
181 \times 4 = 724
\]

discrete periods.

At most one request appears in a period. For class `k`, a nonnegative time-profile weight `w_{t,k}` is assigned to every period. The probability of a class-`k` request in period `t` is

\[
p_{t,k}=\mu_k\frac{w_{t,k}}{\sum_s w_{s,k}},
\]

where `mu_k` is expected total class demand. Therefore

\[
\sum_t p_{t,k}=\mu_k.
\]

The current qualitative profiles are:

- Saver demand is strongest earlier and declines toward departure.
- Main demand is comparatively stable.
- Flex demand is concentrated later in the horizon.

The implementation verifies that total request probability in every period is at most one. If a scenario becomes too concentrated for the discrete model, it fails explicitly rather than silently renormalizing demand.

## 5. Common random numbers

For replication `r`, the simulator creates one seeded request stream. Every policy is evaluated on that identical stream.

This is a common-random-number experimental design. It reduces variance in pairwise policy comparisons because the random demand realization is held fixed while the decision rule changes.

The browser and Python implementations use the same 32-bit linear congruential generator constants:

\[
x_{n+1}=(1664525x_n+1013904223)\bmod 2^{32}.
\]

The seed is user-visible so a scenario can be reproduced.

## 6. Open Sales baseline

Open Sales accepts every request while capacity remains.

It has no protection level and no forecast-based control. It is useful because any modeled lift can be stated relative to a simple policy that is easy to understand.

## 7. EMSR-b

EMSR-b sorts fare groups from highest to lowest fare. At each fare boundary, higher-fare classes are aggregated into one demand distribution and represented by a demand-weighted average higher fare.

AeroYield assumes independent Poisson total demand by fare group. For a sum of independent Poisson demands,

\[
\mu=\sum_k \mu_k, \qquad \sigma^2=\mu.
\]

For lower fare `f_L` and aggregated higher fare `\bar f_H`, the EMSR critical probability is

\[
P(D_H \le y)=1-\frac{f_L}{\bar f_H}.
\]

The implementation uses a normal approximation to the aggregate Poisson demand to obtain protection level `y`, rounds to an integer, and clips to `[0,C]`.

A low-fare request is accepted only when remaining capacity is strictly greater than its protection level.

### Guarantee

EMSR-b is a heuristic. It is computationally inexpensive and interpretable, but it is not generally optimal for finite-horizon stochastic seat control.

## 8. Finite-horizon dynamic program

The DP uses state

\[
(t,c),
\]

where `t` is booking period and `c` is remaining capacity.

Let `p_{t,k}` be the probability of a class-`k` request and let

\[
p_{t,0}=1-\sum_k p_{t,k}
\]

be the probability of no request. With terminal value zero at departure, the Bellman recursion is

\[
V_t(c)=p_{t,0}V_{t+1}(c)
+\sum_k p_{t,k}\max\left(V_{t+1}(c), f_k+V_{t+1}(c-1)\right)
\]

for `c>0`.

The opportunity cost or bid price of consuming one seat is

\[
b_t(c)=V_{t+1}(c)-V_{t+1}(c-1).
\]

A request is accepted exactly when

\[
f_k \ge b_t(c).
\]

### Guarantee

The implemented DP is exact for the stated discretized model: one flight, one-seat requests, at most one request per opportunity, known request probabilities, no cancellations/no-shows/overbooking, and additive ticket revenue.

It is not claimed to be globally optimal for a real airline network.

## 9. Clairvoyant upper bound

For each realized request stream, the clairvoyant benchmark observes every future request before making any allocation. It sorts requests by fare and accepts the highest fares up to capacity.

Therefore, for the same realized demand stream,

\[
R_{\text{policy}} \le R_{\text{clairvoyant}}
\]

for any feasible online policy in this model.

Clairvoyant revenue is never presented as deployable performance. It is used only to define an upper bound and regret.

## 10. Evaluation metrics

For every policy and replication, AeroYield records:

- **Revenue:** sum of accepted fares.
- **Accepted requests:** number of seats sold.
- **Load factor:** accepted requests divided by capacity.
- **Rejected requests / spill:** generated requests not accepted.
- **Empty seats / spoilage:** capacity remaining at departure.
- **Average accepted fare:** revenue divided by accepted requests.
- **Regret:** clairvoyant revenue minus policy revenue for the same request stream.

Across replications the dashboard reports mean values and the 10th, 50th, and 90th percentiles of revenue.

## 11. Route opportunity score

The route screener includes a prioritization score to decide where deeper analysis is most useful. It is not an optimizer and not a predicted revenue lift.

The score is a weighted combination of within-extract percentile ranks:

- 50% estimated market value
- 25% passenger volume
- 15% monthly fare variability
- 10% reporting-carrier breadth

The score answers “where should an analyst look first?” rather than “how much will this route improve?”

## 12. Reproducibility and testing

The Python and browser implementations deliberately mirror the same policy and simulation concepts. CI tests:

- deterministic seat-allocation feasibility
- EMSR protection-level semantics
- exact DP behavior on analytically solvable toy problems
- seeded request-stream reproducibility
- clairvoyant upper-bound dominance
- passenger-weighted distance and carrier-share calculations
- local site assets, navigation, and required optimizer/simulator wiring
- Python compilation and JavaScript syntax

## 13. Scope that is intentionally left for future work

AeroYield stops at single-flight revenue management so the model remains explainable and the mathematical guarantees remain clear. Natural extensions are:

- connecting itineraries and network bid-price control
- leg-level displacement cost
- overbooking with denied-boarding penalties
- cancellations and no-shows
- richer fare-family restrictions
- calibrated booking curves from reservation-system data
- competitive price response
- demand forecasting and forecast uncertainty
- approximate dynamic programming for larger state spaces
