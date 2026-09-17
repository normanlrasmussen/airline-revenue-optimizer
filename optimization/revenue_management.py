#!/usr/bin/env python3
"""Single-flight airline revenue-management policies used by AeroYield.

The models are intentionally small and transparent:
- open sales: accept every request while capacity remains;
- EMSR-b: nested protection levels using independent Poisson demand and a normal approximation;
- finite-horizon stochastic DP: exact for a discretized process with at most one request per period;
- deterministic LP / bid-price control: expected-demand shadow prices;
- Bayesian booking-pace adaptation: Gamma-Poisson demand-scale updates used by an adaptive DP controller;
- distributionally robust DP: Bellman recursion under a rectangular total-variation ambiguity set;
- clairvoyant allocation: an upper bound that knows realized demand before selling any seat.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import sqrt
from statistics import NormalDist
from typing import Mapping, Sequence


@dataclass(frozen=True)
class FareDemand:
    name: str
    fare: float
    mean_demand: float


@dataclass(frozen=True)
class EMSRBResult:
    ordered_classes: tuple[FareDemand, ...]
    protection_for_request: dict[str, int]
    booking_limit: dict[str, int]


@dataclass(frozen=True)
class DPResult:
    class_fares: dict[str, float]
    values: tuple[tuple[float, ...], ...]
    bid_prices: tuple[tuple[float, ...], ...]

    @property
    def periods(self) -> int:
        return len(self.values) - 1

    @property
    def capacity(self) -> int:
        return len(self.values[0]) - 1 if self.values else 0

    @property
    def expected_revenue(self) -> float:
        return self.values[0][self.capacity]

    def accept(self, period: int, remaining_capacity: int, fare: float) -> bool:
        if remaining_capacity <= 0:
            return False
        if not 0 <= period < self.periods:
            raise IndexError("period is outside the DP horizon")
        if remaining_capacity > self.capacity:
            raise ValueError("remaining_capacity exceeds the DP capacity")
        return fare + 1e-12 >= self.bid_prices[period][remaining_capacity]


@dataclass(frozen=True)
class LPBidPriceResult:
    class_fares: dict[str, float]
    bid_prices: tuple[tuple[float, ...], ...]

    @property
    def periods(self) -> int:
        return len(self.bid_prices)

    @property
    def capacity(self) -> int:
        return len(self.bid_prices[0]) - 1 if self.bid_prices else 0

    def accept(self, period: int, remaining_capacity: int, fare: float) -> bool:
        if remaining_capacity <= 0:
            return False
        if not 0 <= period < self.periods:
            raise IndexError("period is outside the LP horizon")
        if remaining_capacity > self.capacity:
            raise ValueError("remaining_capacity exceeds the LP capacity")
        return fare + 1e-12 >= self.bid_prices[period][remaining_capacity]


def open_sales_accept(remaining_capacity: int) -> bool:
    """Accept any request while at least one seat remains."""
    return remaining_capacity > 0


def _validate_classes(classes: Sequence[FareDemand]) -> tuple[FareDemand, ...]:
    if not classes:
        raise ValueError("at least one fare class is required")
    if any(c.fare < 0 or c.mean_demand < 0 for c in classes):
        raise ValueError("fare and mean demand must be non-negative")
    return tuple(sorted(classes, key=lambda c: c.fare, reverse=True))


def _validate_probability_rows(
    class_fares: Mapping[str, float],
    period_request_probabilities: Sequence[Mapping[str, float]],
) -> None:
    names = set(class_fares)
    for probs in period_request_probabilities:
        unknown = set(probs) - names
        if unknown:
            raise KeyError(f"probabilities supplied for unknown classes: {sorted(unknown)}")
        if any(p < 0 for p in probs.values()):
            raise ValueError("request probabilities must be non-negative")
        if sum(probs.values()) > 1.0 + 1e-12:
            raise ValueError("class request probabilities must sum to at most one per period")


def emsr_b(capacity: int, classes: Sequence[FareDemand]) -> EMSRBResult:
    """Compute EMSR-b nested protection levels.

    Demand for each fare class is modeled as independent Poisson demand, so the
    aggregate variance of higher-fare demand equals its aggregate mean. EMSR-b
    replaces the higher-fare classes with one demand distribution and one
    demand-weighted average fare at each fare boundary.

    ``protection_for_request[name]`` is the number of seats protected from a
    request in that class. A request is accepted when remaining capacity is
    strictly greater than that protection level.
    """
    if capacity < 0:
        raise ValueError("capacity must be non-negative")
    ordered = _validate_classes(classes)
    protection = {ordered[0].name: 0}
    booking_limit = {ordered[0].name: capacity}

    cumulative_mean = 0.0
    cumulative_fare_demand = 0.0
    for i in range(len(ordered) - 1):
        higher = ordered[i]
        lower = ordered[i + 1]
        cumulative_mean += higher.mean_demand
        cumulative_fare_demand += higher.fare * higher.mean_demand

        if cumulative_mean <= 0:
            protect = 0
        else:
            weighted_high_fare = cumulative_fare_demand / cumulative_mean
            critical_probability = 1.0 - lower.fare / weighted_high_fare if weighted_high_fare > 0 else 0.0
            critical_probability = min(max(critical_probability, 1e-9), 1.0 - 1e-9)
            sigma = sqrt(cumulative_mean)
            if sigma == 0:
                raw_protection = cumulative_mean
            else:
                raw_protection = NormalDist(mu=cumulative_mean, sigma=sigma).inv_cdf(critical_probability)
            protect = int(round(min(max(raw_protection, 0.0), float(capacity))))

        protection[lower.name] = protect
        booking_limit[lower.name] = max(0, capacity - protect)

    return EMSRBResult(ordered, protection, booking_limit)


def emsr_b_accept(result: EMSRBResult, class_name: str, remaining_capacity: int) -> bool:
    """Apply an EMSR-b protection level to one booking request."""
    if remaining_capacity <= 0:
        return False
    if class_name not in result.protection_for_request:
        raise KeyError(f"unknown fare class: {class_name}")
    return remaining_capacity > result.protection_for_request[class_name]


def solve_finite_horizon_dp(
    capacity: int,
    class_fares: Mapping[str, float],
    period_request_probabilities: Sequence[Mapping[str, float]],
) -> DPResult:
    """Solve the exact finite-horizon seat-control DP for a discretized process.

    Each period contains either no request or exactly one request. The supplied
    class probabilities therefore must sum to at most one in every period.
    State is ``(period, remaining_capacity)``. The Bellman recursion compares
    rejecting a request with accepting its fare plus the continuation value of
    one fewer seat.
    """
    if capacity < 0:
        raise ValueError("capacity must be non-negative")
    if not class_fares:
        raise ValueError("at least one fare is required")
    if any(fare < 0 for fare in class_fares.values()):
        raise ValueError("fares must be non-negative")
    _validate_probability_rows(class_fares, period_request_probabilities)

    periods = len(period_request_probabilities)
    values = [[0.0 for _ in range(capacity + 1)] for _ in range(periods + 1)]
    bid_prices = [[0.0 for _ in range(capacity + 1)] for _ in range(periods)]

    for t in range(periods - 1, -1, -1):
        probs = period_request_probabilities[t]
        request_probability = sum(probs.values())
        p_none = max(0.0, 1.0 - request_probability)

        for c in range(capacity + 1):
            reject_value = values[t + 1][c]
            expected = p_none * reject_value
            for name, probability in probs.items():
                if c == 0:
                    best = reject_value
                else:
                    accept_value = class_fares[name] + values[t + 1][c - 1]
                    best = max(reject_value, accept_value)
                expected += probability * best
            values[t][c] = expected
            if c > 0:
                bid_prices[t][c] = values[t + 1][c] - values[t + 1][c - 1]

    return DPResult(
        class_fares=dict(class_fares),
        values=tuple(tuple(row) for row in values),
        bid_prices=tuple(tuple(row) for row in bid_prices),
    )


def deterministic_lp_bid_price(
    capacity: float,
    class_fares: Mapping[str, float],
    expected_remaining_demand: Mapping[str, float],
) -> float:
    """Return the single-resource deterministic LP capacity shadow price.

    The deterministic relaxation is

        max sum_k fare_k x_k
        s.t. sum_k x_k <= capacity,
             0 <= x_k <= expected_demand_k.

    For a single leg, sorting by fare solves the LP. The marginal fare at which
    expected demand fills capacity is a valid capacity bid price. If expected
    demand does not fill capacity, the shadow price is zero.
    """
    if capacity <= 0:
        return float("inf")
    if set(expected_remaining_demand) - set(class_fares):
        raise KeyError("expected demand supplied for an unknown fare class")
    if any(f < 0 for f in class_fares.values()) or any(d < 0 for d in expected_remaining_demand.values()):
        raise ValueError("fares and expected demand must be non-negative")

    remaining = float(capacity)
    for name, fare in sorted(class_fares.items(), key=lambda item: item[1], reverse=True):
        demand = float(expected_remaining_demand.get(name, 0.0))
        if demand <= 0:
            continue
        if remaining <= demand + 1e-12:
            return float(fare)
        remaining -= demand
    return 0.0


def solve_deterministic_lp_bid_prices(
    capacity: int,
    class_fares: Mapping[str, float],
    period_request_probabilities: Sequence[Mapping[str, float]],
) -> LPBidPriceResult:
    """Build time-varying deterministic LP bid prices from the baseline forecast."""
    if capacity < 0:
        raise ValueError("capacity must be non-negative")
    if not class_fares:
        raise ValueError("at least one fare is required")
    _validate_probability_rows(class_fares, period_request_probabilities)

    periods = len(period_request_probabilities)
    suffix = {
        name: [0.0 for _ in range(periods + 1)]
        for name in class_fares
    }
    for t in range(periods - 1, -1, -1):
        for name in class_fares:
            suffix[name][t] = suffix[name][t + 1] + float(period_request_probabilities[t].get(name, 0.0))

    bid_prices = [[0.0 for _ in range(capacity + 1)] for _ in range(periods)]
    for t in range(periods):
        demand = {name: suffix[name][t] for name in class_fares}
        for c in range(1, capacity + 1):
            bid_prices[t][c] = deterministic_lp_bid_price(c, class_fares, demand)

    return LPBidPriceResult(
        class_fares=dict(class_fares),
        bid_prices=tuple(tuple(row) for row in bid_prices),
    )


def gamma_poisson_demand_scale(
    observed_demand: float,
    expected_exposure: float,
    *,
    prior_strength: float = 30.0,
    lower: float = 0.5,
    upper: float = 1.75,
) -> float:
    """Posterior mean demand multiplier for a Gamma-Poisson booking-pace model.

    A Gamma prior with shape=rate=``prior_strength`` has prior mean one. If
    observed cumulative seat requests are modeled as Poisson with mean
    ``scale * expected_exposure``, the posterior mean scale is

        (prior_strength + observed) / (prior_strength + expected_exposure).

    Clipping keeps the certainty-equivalent adaptive controller inside the same
    plausible demand range used by AeroYield's simulation experiments.
    """
    if observed_demand < 0 or expected_exposure < 0:
        raise ValueError("observed demand and expected exposure must be non-negative")
    if prior_strength <= 0:
        raise ValueError("prior_strength must be positive")
    if lower <= 0 or upper < lower:
        raise ValueError("invalid posterior scale bounds")
    posterior_mean = (prior_strength + observed_demand) / (prior_strength + expected_exposure)
    return min(upper, max(lower, posterior_mean))


def scale_probability_schedule(
    period_request_probabilities: Sequence[Mapping[str, float]],
    scale: float,
    *,
    max_request_probability: float = 0.98,
) -> list[dict[str, float]]:
    """Scale a forecast demand schedule while preserving each period's class mix."""
    if scale < 0:
        raise ValueError("scale must be non-negative")
    if not 0 < max_request_probability <= 1:
        raise ValueError("max_request_probability must lie in (0, 1]")
    result: list[dict[str, float]] = []
    for row in period_request_probabilities:
        scaled = {name: float(probability) * scale for name, probability in row.items()}
        total = sum(scaled.values())
        if total > max_request_probability:
            factor = max_request_probability / total
            scaled = {name: probability * factor for name, probability in scaled.items()}
        result.append(scaled)
    return result


def _worst_case_tv_expectation(
    base_probabilities: Sequence[float],
    outcome_values: Sequence[float],
    radius: float,
) -> float:
    """Minimize expected value over a total-variation ball around a distribution."""
    if len(base_probabilities) != len(outcome_values) or not base_probabilities:
        raise ValueError("probabilities and values must have equal non-zero length")
    if not 0 <= radius <= 1:
        raise ValueError("total-variation radius must lie in [0, 1]")
    if any(p < -1e-12 for p in base_probabilities):
        raise ValueError("probabilities must be non-negative")
    if abs(sum(base_probabilities) - 1.0) > 1e-9:
        raise ValueError("base probabilities must sum to one")

    q = [max(0.0, float(p)) for p in base_probabilities]
    order = sorted(range(len(q)), key=lambda i: outcome_values[i])
    low_pos = 0
    high_pos = len(order) - 1
    budget = float(radius)

    while budget > 1e-15 and low_pos < high_pos:
        low = order[low_pos]
        high = order[high_pos]
        if outcome_values[high] <= outcome_values[low] + 1e-15:
            break
        move = min(q[high], 1.0 - q[low], budget)
        if move <= 1e-15:
            if q[high] <= 1e-15:
                high_pos -= 1
            if 1.0 - q[low] <= 1e-15:
                low_pos += 1
            continue
        q[high] -= move
        q[low] += move
        budget -= move
        if q[high] <= 1e-15:
            high_pos -= 1
        if 1.0 - q[low] <= 1e-15:
            low_pos += 1

    return sum(probability * value for probability, value in zip(q, outcome_values))


def solve_distributionally_robust_dp(
    capacity: int,
    class_fares: Mapping[str, float],
    period_request_probabilities: Sequence[Mapping[str, float]],
    *,
    tv_radius: float = 0.075,
) -> DPResult:
    """Solve a rectangular total-variation distributionally robust DP.

    At each period, the baseline categorical distribution over
    ``{no request} U fare classes`` is surrounded by a total-variation ball.
    Nature chooses the distribution in that ball that minimizes the Bellman
    continuation value. Because the ambiguity set is rectangular across
    periods, the robust Bellman recursion remains time consistent.
    """
    if capacity < 0:
        raise ValueError("capacity must be non-negative")
    if not class_fares:
        raise ValueError("at least one fare is required")
    if any(fare < 0 for fare in class_fares.values()):
        raise ValueError("fares must be non-negative")
    if not 0 <= tv_radius <= 1:
        raise ValueError("tv_radius must lie in [0, 1]")
    _validate_probability_rows(class_fares, period_request_probabilities)

    names = list(class_fares)
    periods = len(period_request_probabilities)
    values = [[0.0 for _ in range(capacity + 1)] for _ in range(periods + 1)]
    bid_prices = [[0.0 for _ in range(capacity + 1)] for _ in range(periods)]

    for t in range(periods - 1, -1, -1):
        probs = period_request_probabilities[t]
        request_probability = sum(probs.values())
        base_distribution = [max(0.0, 1.0 - request_probability)] + [
            float(probs.get(name, 0.0)) for name in names
        ]

        for c in range(capacity + 1):
            reject_value = values[t + 1][c]
            outcomes = [reject_value]
            for name in names:
                if c == 0:
                    outcomes.append(reject_value)
                else:
                    outcomes.append(
                        max(
                            reject_value,
                            float(class_fares[name]) + values[t + 1][c - 1],
                        )
                    )
            values[t][c] = _worst_case_tv_expectation(
                base_distribution,
                outcomes,
                tv_radius,
            )
            if c > 0:
                bid_prices[t][c] = values[t + 1][c] - values[t + 1][c - 1]

    return DPResult(
        class_fares=dict(class_fares),
        values=tuple(tuple(row) for row in values),
        bid_prices=tuple(tuple(row) for row in bid_prices),
    )


def clairvoyant_allocation(
    capacity: int,
    realized_demand: Mapping[str, int],
    class_fares: Mapping[str, float],
) -> tuple[dict[str, int], float]:
    """Return the perfect-information upper bound for one realized demand vector."""
    if capacity < 0:
        raise ValueError("capacity must be non-negative")
    if set(realized_demand) != set(class_fares):
        raise ValueError("realized_demand and class_fares must have the same class names")
    if any(d < 0 for d in realized_demand.values()) or any(f < 0 for f in class_fares.values()):
        raise ValueError("demand and fares must be non-negative")

    remaining = capacity
    allocation = {name: 0 for name in class_fares}
    revenue = 0.0
    for name, fare in sorted(class_fares.items(), key=lambda item: item[1], reverse=True):
        seats = min(int(realized_demand[name]), remaining)
        allocation[name] = seats
        revenue += seats * fare
        remaining -= seats
        if remaining == 0:
            break
    return allocation, revenue
