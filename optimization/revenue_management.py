#!/usr/bin/env python3
"""Single-flight airline revenue-management policies used by AeroYield.

The models are intentionally small and transparent:
- open sales: accept every request while capacity remains;
- EMSR-b: nested protection levels using independent Poisson demand and a normal approximation;
- finite-horizon stochastic DP: exact for a discretized process with at most one request per period;
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


def open_sales_accept(remaining_capacity: int) -> bool:
    """Accept any request while at least one seat remains."""
    return remaining_capacity > 0


def _validate_classes(classes: Sequence[FareDemand]) -> tuple[FareDemand, ...]:
    if not classes:
        raise ValueError("at least one fare class is required")
    if any(c.fare < 0 or c.mean_demand < 0 for c in classes):
        raise ValueError("fare and mean demand must be non-negative")
    return tuple(sorted(classes, key=lambda c: c.fare, reverse=True))


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

    periods = len(period_request_probabilities)
    values = [[0.0 for _ in range(capacity + 1)] for _ in range(periods + 1)]
    bid_prices = [[0.0 for _ in range(capacity + 1)] for _ in range(periods)]

    for t in range(periods - 1, -1, -1):
        probs = period_request_probabilities[t]
        unknown = set(probs) - set(class_fares)
        if unknown:
            raise KeyError(f"probabilities supplied for unknown classes: {sorted(unknown)}")
        if any(p < 0 for p in probs.values()):
            raise ValueError("request probabilities must be non-negative")
        request_probability = sum(probs.values())
        if request_probability > 1.0 + 1e-12:
            raise ValueError("class request probabilities must sum to at most one per period")
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
