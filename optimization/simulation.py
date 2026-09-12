#!/usr/bin/env python3
"""Seeded Monte Carlo experiment engine for AeroYield.

The simulator uses the same discrete model as the browser: four booking
opportunities per day over a 180-day horizon, with at most one request per
opportunity. Every policy receives the same generated request stream within a
replication (common random numbers).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from optimization.revenue_management import (
    FareDemand,
    clairvoyant_allocation,
    emsr_b,
    emsr_b_accept,
    solve_finite_horizon_dp,
)

DAYS = 180
SLOTS_PER_DAY = 4
PERIODS = (DAYS + 1) * SLOTS_PER_DAY


@dataclass(frozen=True)
class BookingEvent:
    period: int
    day: int
    name: str
    fare: float


@dataclass(frozen=True)
class PolicyOutcome:
    revenue: float
    accepted: int
    rejected: int
    empty_seats: int
    load_factor: float
    average_accepted_fare: float


class LCG:
    """32-bit LCG matching the browser implementation."""

    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF

    def random(self) -> float:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296


def _profile(name: str, progress: float) -> float:
    if name == "Saver":
        return max(0.15, 1.0 - 0.75 * progress)
    if name == "Main":
        return 0.75 + 0.10 * progress
    return 0.20 + 0.80 * progress**1.8


def build_probabilities(classes: Sequence[FareDemand]) -> list[dict[str, float]]:
    profiles = {fc.name: [] for fc in classes}
    totals = {fc.name: 0.0 for fc in classes}
    for period in range(PERIODS):
        day = DAYS - period // SLOTS_PER_DAY
        progress = (DAYS - day) / DAYS
        for fc in classes:
            weight = _profile(fc.name, progress)
            profiles[fc.name].append(weight)
            totals[fc.name] += weight

    result: list[dict[str, float]] = []
    for period in range(PERIODS):
        row: dict[str, float] = {}
        for fc in classes:
            row[fc.name] = 0.0 if fc.mean_demand <= 0 else fc.mean_demand * profiles[fc.name][period] / totals[fc.name]
        if sum(row.values()) > 1.0 + 1e-10:
            raise ValueError("modeled demand is too concentrated for one request per booking opportunity")
        result.append(row)
    return result


def generate_stream(classes: Sequence[FareDemand], probabilities: Sequence[Mapping[str, float]], seed: int) -> list[BookingEvent]:
    rng = LCG(seed)
    by_name = {fc.name: fc for fc in classes}
    ordered_names = [fc.name for fc in classes]
    events: list[BookingEvent] = []
    for period, probs in enumerate(probabilities):
        r = rng.random()
        cumulative = 0.0
        selected = None
        for name in ordered_names:
            cumulative += float(probs.get(name, 0.0))
            if r < cumulative:
                selected = by_name[name]
                break
        if selected is not None:
            events.append(
                BookingEvent(
                    period=period,
                    day=DAYS - period // SLOTS_PER_DAY,
                    name=selected.name,
                    fare=selected.fare,
                )
            )
    return events


def run_policy(events: Sequence[BookingEvent], capacity: int, accept) -> PolicyOutcome:
    remaining = capacity
    revenue = 0.0
    accepted = 0
    rejected = 0
    for event in events:
        if remaining > 0 and accept(event, remaining):
            remaining -= 1
            accepted += 1
            revenue += event.fare
        else:
            rejected += 1
    return PolicyOutcome(
        revenue=revenue,
        accepted=accepted,
        rejected=rejected,
        empty_seats=remaining,
        load_factor=accepted / capacity if capacity else 0.0,
        average_accepted_fare=revenue / accepted if accepted else 0.0,
    )


def simulate_replication(classes: Sequence[FareDemand], capacity: int, seed: int) -> dict[str, PolicyOutcome]:
    probabilities = build_probabilities(classes)
    fares = {fc.name: fc.fare for fc in classes}
    emsr = emsr_b(capacity, classes)
    dp = solve_finite_horizon_dp(capacity, fares, probabilities)
    events = generate_stream(classes, probabilities, seed)

    open_result = run_policy(events, capacity, lambda _event, _remaining: True)
    emsr_result = run_policy(events, capacity, lambda event, remaining: emsr_b_accept(emsr, event.name, remaining))
    dp_result = run_policy(events, capacity, lambda event, remaining: dp.accept(event.period, remaining, event.fare))

    realized = {fc.name: 0 for fc in classes}
    for event in events:
        realized[event.name] += 1
    allocation, clair_revenue = clairvoyant_allocation(capacity, realized, fares)
    clair_accepted = sum(allocation.values())
    clair = PolicyOutcome(
        revenue=clair_revenue,
        accepted=clair_accepted,
        rejected=max(0, len(events) - clair_accepted),
        empty_seats=max(0, capacity - clair_accepted),
        load_factor=clair_accepted / capacity if capacity else 0.0,
        average_accepted_fare=clair_revenue / clair_accepted if clair_accepted else 0.0,
    )
    return {"open": open_result, "emsr": emsr_result, "dp": dp_result, "clairvoyant": clair}
