# Advanced AeroYield Policies

AeroYield now includes three additional deployable seat-control policies alongside Open Sales, EMSR-b, finite-horizon DP, and the optional locally trained neural network.

All three policies preserve the same information boundary: they may use the baseline fare/demand forecast, the current booking request, current time, current booking capacity, and information observed up to the current decision. They do not receive future realized requests, future cancellations, future no-shows, the realized demand shock, or oracle outcomes.

## 1. Deterministic LP / bid-price control

For remaining expected demand `d_k`, fares `f_k`, and remaining booking capacity `c`, the deterministic relaxation is

```text
max  sum_k f_k x_k
s.t. sum_k x_k <= c
     0 <= x_k <= d_k.
```

Because AeroYield is currently a single-leg, single-resource problem, the LP is solved by allocating expected demand from highest to lowest fare. The fare of the marginal class is a valid capacity shadow price. If expected demand does not fill the remaining capacity, the bid price is zero.

The browser precomputes this bid price for every booking period and capacity state using only the baseline remaining-demand forecast. A multi-seat request is accepted when its total fare covers the sum of the relevant per-seat bid prices.

**Guarantee:** exact for the deterministic single-resource LP relaxation. It is not an optimality guarantee for the stochastic realized booking process.

## 2. Bayesian Adaptive DP

The adaptive controller treats total demand intensity as an unknown multiplier `theta` on the baseline booking forecast. It uses a Gamma-Poisson booking-pace model with a prior mean of one.

If cumulative observed seat requests are `N_t`, cumulative baseline expected seat demand is `E_t`, and the prior shape/rate is `a`, the posterior mean multiplier is

```text
theta_hat_t = (a + N_t) / (a + E_t).
```

AeroYield uses `a = 30` and clips the posterior mean to `[0.5, 1.75]`. It pre-solves a grid of finite-horizon DPs under different demand multipliers. At each observed request, the posterior is updated from booking pace and the nearest pre-solved DP policy is used.

This design makes adaptation inexpensive enough for the browser while still allowing the controller to react when bookings arrive materially faster or slower than forecast.

**Information boundary:** only requests observed so far affect the posterior. No future event or realized future arrival probability is exposed.

**Guarantee:** this is a certainty-equivalent Bayesian adaptive controller. It is not the exact Bayes-adaptive MDP because the posterior distribution itself is not included in the Bellman state.

## 3. Distributionally Robust DP

The baseline per-period request model is a categorical distribution over

```text
{no request, Saver, Main, Flex}.
```

For each period, AeroYield places a total-variation ambiguity set around that baseline distribution. The robust Bellman recursion evaluates the worst expected continuation value among all distributions inside that set before computing the seat bid price.

For baseline distribution `p`, the ambiguity set is

```text
U(p, epsilon) = {q : TV(q, p) <= epsilon}.
```

The browser computes the inner worst-case expectation by moving up to `epsilon` probability mass from the highest-value outcomes to the lowest-value outcomes. The Bellman recursion then proceeds backward exactly under that rectangular ambiguity model.

The default ambiguity radius is tied to the experiment's assumed demand-uncertainty input:

```text
epsilon = min(0.20, forecast_error_pct / 200).
```

Thus 15% assumed demand uncertainty gives a 7.5% total-variation radius. When the assumed uncertainty is zero, the robust DP collapses exactly to the nominal finite-horizon DP; this equivalence is covered by automated tests.

**Guarantee:** exact for the stated rectangular total-variation ambiguity model. It is not a claim that this ambiguity set is empirically calibrated to a real airline.

## Browser integration

`site/advanced_policies.js` adds all three policies to the Revenue Optimizer. Each policy is evaluated on the same seeded realized booking stream used for the existing methods, so comparisons retain the common-random-number design.

The policy table, average-revenue bars, uncertainty plot, representative cumulative-revenue chart, and methods/mechanics sections automatically include the selected advanced policies.
