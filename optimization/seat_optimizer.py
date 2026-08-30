#!/usr/bin/env python3
"""Starter deterministic seat-allocation optimizer.

This is intentionally small and transparent. It is a clean baseline to replace with
EMSR, stochastic DP, bid prices, or network revenue management later.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product


@dataclass(frozen=True)
class FareClass:
    name: str
    fare: float
    forecast_demand: int


@dataclass(frozen=True)
class AllocationResult:
    allocation: dict[str, int]
    revenue: float
    seats_sold: int
    capacity: int

    @property
    def load_factor(self) -> float:
        return self.seats_sold / self.capacity if self.capacity else 0.0


def optimize_seats(capacity: int, fare_classes: list[FareClass]) -> AllocationResult:
    """Maximize deterministic fare revenue using integer seat allocations.

    Model:
        maximize  sum_k fare[k] * x[k]
        subject to sum_k x[k] <= capacity
                   0 <= x[k] <= forecast_demand[k]
                   x[k] integer

    Enumeration is used on purpose: for aircraft-sized capacities and a handful of
    fare classes it is easy to inspect, dependency-free, and trivial to replace.
    """
    if capacity < 0:
        raise ValueError("capacity must be non-negative")
    if any(fc.fare < 0 or fc.forecast_demand < 0 for fc in fare_classes):
        raise ValueError("fares and forecast demand must be non-negative")

    best_revenue = -1.0
    best_allocation: tuple[int, ...] | None = None

    ranges = [range(fc.forecast_demand + 1) for fc in fare_classes]
    for candidate in product(*ranges):
        seats = sum(candidate)
        if seats > capacity:
            continue
        revenue = sum(x * fc.fare for x, fc in zip(candidate, fare_classes, strict=True))
        if revenue > best_revenue:
            best_revenue = revenue
            best_allocation = candidate

    if best_allocation is None:
        best_allocation = tuple(0 for _ in fare_classes)
        best_revenue = 0.0

    allocation = {fc.name: x for fc, x in zip(fare_classes, best_allocation, strict=True)}
    seats_sold = sum(best_allocation)
    return AllocationResult(allocation, best_revenue, seats_sold, capacity)


def first_come_baseline(capacity: int, fare_classes: list[FareClass]) -> AllocationResult:
    """Simple baseline: low-fare demand arrives first, then increasingly expensive classes."""
    remaining = capacity
    allocation: dict[str, int] = {}
    revenue = 0.0

    for fc in sorted(fare_classes, key=lambda x: x.fare):
        seats = min(fc.forecast_demand, remaining)
        allocation[fc.name] = seats
        revenue += seats * fc.fare
        remaining -= seats

    for fc in fare_classes:
        allocation.setdefault(fc.name, 0)

    seats_sold = capacity - remaining
    return AllocationResult(allocation, revenue, seats_sold, capacity)


def demo() -> None:
    classes = [
        FareClass("Saver", 179, 120),
        FareClass("Main", 319, 70),
        FareClass("Flex", 629, 35),
    ]
    capacity = 180

    baseline = first_come_baseline(capacity, classes)
    optimized = optimize_seats(capacity, classes)

    print("Starter seat allocation")
    print(f"Capacity: {capacity}")
    print(f"Baseline revenue:  ${baseline.revenue:,.0f}")
    print(f"Optimized revenue: ${optimized.revenue:,.0f}")
    print(f"Modeled lift:       ${optimized.revenue - baseline.revenue:,.0f}")
    print("Allocation:", optimized.allocation)


if __name__ == "__main__":
    demo()
