#!/usr/bin/env python3
"""Seeded Monte Carlo experiment engine for AeroYield.

Policies are built from a baseline demand forecast, while each replication
perturbs the realized demand level and booking timing. The realized process can
also contain multi-seat parties, cancellations/refunds, and controlled
overbooking. Only the clairvoyant benchmark sees the full realized future.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from optimization.revenue_management import (
    FareDemand,
    emsr_b,
    solve_finite_horizon_dp,
)

DAYS = 180
SLOTS_PER_DAY = 4
PERIODS = (DAYS + 1) * SLOTS_PER_DAY

PARTY_SIZE_PROBABILITIES = ((1, 0.84), (2, 0.12), (3, 0.03), (4, 0.01))
EXPECTED_PARTY_SIZE = sum(size * probability for size, probability in PARTY_SIZE_PROBABILITIES)
BUMP_COMPENSATION = 400.0


@dataclass(frozen=True)
class BookingEvent:
    period: int
    day: int
    name: str
    fare: float
    party_size: int = 1
    will_cancel: bool = False
    cancel_period: int | None = None


@dataclass(frozen=True)
class PolicyOutcome:
    revenue: float
    accepted: int
    rejected: int
    empty_seats: int
    load_factor: float
    average_accepted_fare: float
    boarded: int = 0
    cancelled: int = 0
    denied_boarding: int = 0
    refunds: float = 0.0
    gross_revenue: float = 0.0


class LCG:
    """32-bit LCG matching the browser implementation."""

    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF

    def random(self) -> float:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296


def _profile(name: str, progress: float) -> float:
    progress = min(max(progress, 0.0), 1.0)
    if name == "Saver":
        return max(0.15, 1.0 - 0.75 * progress)
    if name == "Main":
        return 0.75 + 0.10 * progress
    return 0.20 + 0.80 * progress**1.8


def build_probabilities(classes: Sequence[FareDemand]) -> list[dict[str, float]]:
    """Build the baseline forecast used by EMSR-b and the DP."""
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


def build_realized_probabilities(
    classes: Sequence[FareDemand],
    rng: LCG,
    *,
    forecast_error_pct: float = 15.0,
    timing_jitter_days: float = 14.0,
) -> list[dict[str, float]]:
    """Create a perturbed realized process unknown to the policies.

    ``mean_demand`` is treated as expected seat demand. Party-arrival rates are
    divided by the expected party size so adding groups does not mechanically
    inflate expected seat demand.
    """
    error = max(0.0, float(forecast_error_pct)) / 100.0
    max_shift = max(0.0, float(timing_jitter_days))

    weights: dict[str, list[float]] = {}
    target_parties: dict[str, float] = {}

    for fc in classes:
        demand_multiplier = max(0.25, 1.0 + (2.0 * rng.random() - 1.0) * error)
        shift_days = (2.0 * rng.random() - 1.0) * max_shift
        day_noise = [
            max(0.20, 1.0 + (2.0 * rng.random() - 1.0) * max(0.05, error))
            for _ in range(DAYS + 1)
        ]

        class_weights: list[float] = []
        for period in range(PERIODS):
            day = DAYS - period // SLOTS_PER_DAY
            shifted_progress = (DAYS - day - shift_days) / DAYS
            class_weights.append(_profile(fc.name, shifted_progress) * day_noise[DAYS - day])

        weights[fc.name] = class_weights
        target_parties[fc.name] = max(0.0, fc.mean_demand * demand_multiplier / EXPECTED_PARTY_SIZE)

    totals = {name: sum(values) for name, values in weights.items()}
    result: list[dict[str, float]] = []
    for period in range(PERIODS):
        row = {
            fc.name: 0.0 if target_parties[fc.name] <= 0 else target_parties[fc.name] * weights[fc.name][period] / totals[fc.name]
            for fc in classes
        }
        total = sum(row.values())
        if total > 0.98:
            scale = 0.98 / total
            row = {name: probability * scale for name, probability in row.items()}
        result.append(row)
    return result


def _sample_party_size(rng: LCG) -> int:
    draw = rng.random()
    cumulative = 0.0
    for size, probability in PARTY_SIZE_PROBABILITIES:
        cumulative += probability
        if draw < cumulative:
            return size
    return PARTY_SIZE_PROBABILITIES[-1][0]


def generate_stream(
    classes: Sequence[FareDemand],
    probabilities: Sequence[Mapping[str, float]],
    seed: int,
    *,
    cancellation_rate: float = 0.0,
) -> list[BookingEvent]:
    """Generate parties from a supplied probability schedule.

    This function stays deterministic for tests and callers. For the realistic
    experiment, ``simulate_replication`` supplies a perturbed probability
    schedule rather than the baseline forecast.
    """
    rng = LCG(seed)
    by_name = {fc.name: fc for fc in classes}
    ordered_names = [fc.name for fc in classes]
    cancel_probability = min(max(float(cancellation_rate), 0.0), 1.0)
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

        if selected is None:
            continue

        party_size = _sample_party_size(rng)
        will_cancel = rng.random() < cancel_probability and period < PERIODS - 1
        cancel_period = None
        if will_cancel:
            remaining = PERIODS - period - 1
            cancel_period = period + 1 + min(remaining - 1, int(rng.random() * remaining))

        events.append(
            BookingEvent(
                period=period,
                day=DAYS - period // SLOTS_PER_DAY,
                name=selected.name,
                fare=selected.fare,
                party_size=party_size,
                will_cancel=will_cancel,
                cancel_period=cancel_period,
            )
        )
    return events


def _emsr_accept_group(emsr, event: BookingEvent, remaining: int) -> bool:
    if event.party_size > remaining:
        return False
    protection = emsr.protection_for_request[event.name]
    return remaining - event.party_size >= protection


def _dp_accept_group(dp, event: BookingEvent, remaining: int) -> bool:
    if event.party_size > remaining or remaining <= 0:
        return False
    t = max(0, min(dp.periods - 1, event.period))
    opportunity_cost = 0.0
    for offset in range(event.party_size):
        c = max(1, min(dp.capacity, remaining - offset))
        opportunity_cost += dp.bid_prices[t][c]
    return event.fare * event.party_size + 1e-12 >= opportunity_cost


def run_policy(
    events: Sequence[BookingEvent],
    capacity: int,
    accept,
    *,
    booking_limit: int | None = None,
    refund_rate: float = 0.70,
    bump_compensation: float = BUMP_COMPENSATION,
) -> PolicyOutcome:
    """Run an online policy without exposing future cancellations or demand."""
    physical_capacity = max(0, int(capacity))
    sales_limit = max(physical_capacity, int(booking_limit if booking_limit is not None else physical_capacity))
    refund_fraction = min(max(float(refund_rate), 0.0), 1.0)

    active: dict[int, BookingEvent] = {}
    active_seats = 0
    gross_revenue = 0.0
    net_revenue = 0.0
    accepted = 0
    rejected = 0
    cancelled = 0
    refunds = 0.0

    events_by_period: dict[int, list[tuple[int, BookingEvent]]] = {}
    cancellations_by_period: dict[int, list[int]] = {}
    for event_id, event in enumerate(events):
        events_by_period.setdefault(event.period, []).append((event_id, event))
        if event.cancel_period is not None:
            cancellations_by_period.setdefault(event.cancel_period, []).append(event_id)

    for period in range(PERIODS):
        for event_id in cancellations_by_period.get(period, []):
            event = active.pop(event_id, None)
            if event is None:
                continue
            active_seats -= event.party_size
            cancelled += event.party_size
            refund = event.fare * event.party_size * refund_fraction
            refunds += refund
            net_revenue -= refund

        for event_id, event in events_by_period.get(period, []):
            remaining = sales_limit - active_seats
            if event.party_size <= remaining and accept(event, remaining):
                active[event_id] = event
                active_seats += event.party_size
                accepted += event.party_size
                sale = event.fare * event.party_size
                gross_revenue += sale
                net_revenue += sale
            else:
                rejected += event.party_size

    denied_boarding = max(0, active_seats - physical_capacity)
    boarded = min(active_seats, physical_capacity)

    if denied_boarding:
        active_fares: list[float] = []
        for event in active.values():
            active_fares.extend([event.fare] * event.party_size)
        active_fares.sort()
        denied_refunds = sum(active_fares[:denied_boarding])
        refunds += denied_refunds
        net_revenue -= denied_refunds + denied_boarding * float(bump_compensation)

    empty_seats = max(0, physical_capacity - boarded)
    return PolicyOutcome(
        revenue=net_revenue,
        accepted=accepted,
        rejected=rejected,
        empty_seats=empty_seats,
        load_factor=boarded / physical_capacity if physical_capacity else 0.0,
        average_accepted_fare=gross_revenue / accepted if accepted else 0.0,
        boarded=boarded,
        cancelled=cancelled,
        denied_boarding=denied_boarding,
        refunds=refunds,
        gross_revenue=gross_revenue,
    )


def clairvoyant_upper_bound(
    events: Sequence[BookingEvent],
    capacity: int,
    *,
    refund_rate: float = 0.70,
) -> PolicyOutcome:
    """Relaxed perfect-information upper bound.

    The oracle knows which bookings will cancel. Cancelled parties contribute
    retained fare without final seat use. Non-cancelled parties are solved as a
    0/1 knapsack against physical capacity. Transient booking-limit constraints
    are relaxed, so this remains an upper bound rather than a deployable policy.
    """
    physical_capacity = max(0, int(capacity))
    refund_fraction = min(max(float(refund_rate), 0.0), 1.0)

    cancelled_events = [event for event in events if event.will_cancel]
    live_events = [event for event in events if not event.will_cancel]

    cancelled_gross = sum(event.fare * event.party_size for event in cancelled_events)
    cancelled_refunds = cancelled_gross * refund_fraction
    cancelled_net = cancelled_gross - cancelled_refunds
    cancelled_seats = sum(event.party_size for event in cancelled_events)

    values = [-float("inf")] * (physical_capacity + 1)
    values[0] = 0.0
    for event in live_events:
        size = event.party_size
        value = event.fare * size
        for used in range(physical_capacity, size - 1, -1):
            if values[used - size] != -float("inf"):
                values[used] = max(values[used], values[used - size] + value)

    best_used = max(range(physical_capacity + 1), key=lambda used: values[used])
    live_revenue = max(0.0, values[best_used])
    accepted = cancelled_seats + best_used
    total_requested = sum(event.party_size for event in events)

    return PolicyOutcome(
        revenue=cancelled_net + live_revenue,
        accepted=accepted,
        rejected=max(0, total_requested - accepted),
        empty_seats=max(0, physical_capacity - best_used),
        load_factor=best_used / physical_capacity if physical_capacity else 0.0,
        average_accepted_fare=(cancelled_gross + live_revenue) / accepted if accepted else 0.0,
        boarded=best_used,
        cancelled=cancelled_seats,
        denied_boarding=0,
        refunds=cancelled_refunds,
        gross_revenue=cancelled_gross + live_revenue,
    )


def simulate_replication(
    classes: Sequence[FareDemand],
    capacity: int,
    seed: int,
    *,
    forecast_error_pct: float = 15.0,
    timing_jitter_days: float = 14.0,
    cancellation_rate: float = 0.08,
    refund_rate: float = 0.70,
    overbooking_pct: float = 5.0,
) -> dict[str, PolicyOutcome]:
    """Simulate one realistic replication under imperfect forecasts."""
    physical_capacity = max(1, int(capacity))
    booking_limit = physical_capacity + round(physical_capacity * max(0.0, overbooking_pct) / 100.0)

    forecast_probabilities = build_probabilities(classes)
    fares = {fc.name: fc.fare for fc in classes}
    emsr = emsr_b(booking_limit, classes)
    dp = solve_finite_horizon_dp(booking_limit, fares, forecast_probabilities)

    truth_rng = LCG((seed ^ 0xA5A5A5A5) & 0xFFFFFFFF)
    realized_probabilities = build_realized_probabilities(
        classes,
        truth_rng,
        forecast_error_pct=forecast_error_pct,
        timing_jitter_days=timing_jitter_days,
    )
    events = generate_stream(
        classes,
        realized_probabilities,
        seed,
        cancellation_rate=cancellation_rate,
    )

    kwargs = dict(
        booking_limit=booking_limit,
        refund_rate=refund_rate,
        bump_compensation=BUMP_COMPENSATION,
    )
    open_result = run_policy(events, physical_capacity, lambda _event, _remaining: True, **kwargs)
    emsr_result = run_policy(
        events,
        physical_capacity,
        lambda event, remaining: _emsr_accept_group(emsr, event, remaining),
        **kwargs,
    )
    dp_result = run_policy(
        events,
        physical_capacity,
        lambda event, remaining: _dp_accept_group(dp, event, remaining),
        **kwargs,
    )
    clair = clairvoyant_upper_bound(events, physical_capacity, refund_rate=refund_rate)

    return {"open": open_result, "emsr": emsr_result, "dp": dp_result, "clairvoyant": clair}
