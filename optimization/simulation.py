#!/usr/bin/env python3
"""Seeded Monte Carlo experiment engine for AeroYield.

Policies are built from a baseline demand forecast. Each replication then draws
a different realized market with correlated demand shocks, booking-timing
variation, multi-seat parties, cancellations, no-shows, refunds, and controlled
overbooking. Only the clairvoyant benchmark sees the realized future.
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
    will_no_show: bool = False


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
    no_show: int = 0
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


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def _normalish(rng: LCG) -> float:
    """Return a bounded, bell-shaped draw in roughly [-1, 1]."""
    return (sum(rng.random() for _ in range(6)) - 3.0) / 3.0


def _correlated_day_noise(rng: LCG, amplitude: float) -> list[float]:
    """Create persistent day-level demand noise instead of independent spikes."""
    if amplitude <= 0:
        return [1.0] * (DAYS + 1)

    state = 0.0
    result = []
    for _ in range(DAYS + 1):
        state = 0.82 * state + 0.58 * _normalish(rng)
        result.append(_clamp(1.0 + amplitude * state, 0.55, 1.55))
    return result


def _profile(name: str, progress: float) -> float:
    progress = _clamp(progress, 0.0, 1.0)
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
            row[fc.name] = (
                0.0
                if fc.mean_demand <= 0
                else fc.mean_demand * profiles[fc.name][period] / totals[fc.name]
            )
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

    The realization combines a market-wide demand shock with class-specific
    error, a shared timing shift with class-specific timing error, and smooth
    day-to-day demand noise. ``mean_demand`` remains expected seat demand, so
    party-arrival rates are divided by expected party size.
    """
    error = _clamp(float(forecast_error_pct), 0.0, 60.0) / 100.0
    max_shift = _clamp(float(timing_jitter_days), 0.0, 60.0)

    market_demand_shock = _normalish(rng) * error * 0.65
    market_timing_shift = _normalish(rng) * max_shift * 0.65
    market_day_noise = _correlated_day_noise(rng, error * 0.70)

    weights: dict[str, list[float]] = {}
    target_parties: dict[str, float] = {}

    for fc in classes:
        class_demand_shock = _normalish(rng) * error * 0.55
        demand_multiplier = _clamp(
            1.0 + market_demand_shock + class_demand_shock,
            0.35,
            1.75,
        )
        class_timing_shift = _normalish(rng) * max_shift * 0.55
        shift_days = _clamp(
            market_timing_shift + class_timing_shift,
            -max_shift,
            max_shift,
        )
        class_day_noise = _correlated_day_noise(rng, error * 0.25)

        class_weights: list[float] = []
        for period in range(PERIODS):
            day = DAYS - period // SLOTS_PER_DAY
            day_index = DAYS - day
            shifted_progress = (DAYS - day - shift_days) / DAYS
            class_weights.append(
                _profile(fc.name, shifted_progress)
                * market_day_noise[day_index]
                * class_day_noise[day_index]
            )

        weights[fc.name] = class_weights
        target_parties[fc.name] = max(
            0.0,
            fc.mean_demand * demand_multiplier / EXPECTED_PARTY_SIZE,
        )

    totals = {name: sum(values) for name, values in weights.items()}
    result: list[dict[str, float]] = []
    for period in range(PERIODS):
        row = {
            fc.name: (
                0.0
                if target_parties[fc.name] <= 0
                else target_parties[fc.name] * weights[fc.name][period] / totals[fc.name]
            )
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
    no_show_rate: float = 0.0,
) -> list[BookingEvent]:
    """Generate a request stream from a supplied probability schedule.

    Separate deterministic RNG streams are used for arrivals, party sizes, and
    attrition. Changing a cancellation/no-show assumption therefore does not
    silently change the underlying booking arrivals.
    """
    arrival_rng = LCG(seed)
    party_rng = LCG(seed ^ 0xC2B2AE35)
    attrition_rng = LCG(seed ^ 0x27D4EB2F)

    by_name = {fc.name: fc for fc in classes}
    ordered_names = [fc.name for fc in classes]
    base_cancel = _clamp(float(cancellation_rate), 0.0, 1.0)
    no_show_probability = _clamp(float(no_show_rate), 0.0, 1.0)
    events: list[BookingEvent] = []

    for period, probs in enumerate(probabilities):
        draw = arrival_rng.random()
        cumulative = 0.0
        selected = None
        for name in ordered_names:
            cumulative += float(probs.get(name, 0.0))
            if draw < cumulative:
                selected = by_name[name]
                break

        if selected is None:
            continue

        day = DAYS - period // SLOTS_PER_DAY
        party_size = _sample_party_size(party_rng)

        lead_fraction = _clamp(day / DAYS, 0.0, 1.0)
        cancel_probability = _clamp(
            base_cancel * (0.40 + 1.20 * lead_fraction),
            0.0,
            0.85,
        )
        will_cancel = (
            period < PERIODS - 1
            and attrition_rng.random() < cancel_probability
        )

        cancel_period = None
        if will_cancel:
            remaining = PERIODS - period - 1
            delay_fraction = attrition_rng.random() ** 0.55
            cancel_period = period + 1 + min(
                remaining - 1,
                int(delay_fraction * remaining),
            )

        will_no_show = (
            not will_cancel
            and attrition_rng.random() < no_show_probability
        )

        events.append(
            BookingEvent(
                period=period,
                day=day,
                name=selected.name,
                fare=selected.fare,
                party_size=party_size,
                will_cancel=will_cancel,
                cancel_period=cancel_period,
                will_no_show=will_no_show,
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
    """Run an online policy without exposing future demand or attrition."""
    physical_capacity = max(0, int(capacity))
    sales_limit = max(
        physical_capacity,
        int(booking_limit if booking_limit is not None else physical_capacity),
    )
    refund_fraction = _clamp(float(refund_rate), 0.0, 1.0)

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

    no_show = 0
    show_fares: list[float] = []
    for event in active.values():
        if event.will_no_show:
            no_show += event.party_size
        else:
            show_fares.extend([event.fare] * event.party_size)

    denied_boarding = max(0, len(show_fares) - physical_capacity)
    boarded = len(show_fares) - denied_boarding

    if denied_boarding:
        show_fares.sort()
        denied_refunds = sum(show_fares[:denied_boarding])
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
        no_show=no_show,
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

    The oracle knows which requests will cancel or no-show. Those bookings do
    not consume final aircraft capacity. Remaining show-up parties are selected
    by 0/1 knapsack against physical capacity. Transient booking-limit
    constraints are relaxed, so this is intentionally unattainable.
    """
    physical_capacity = max(0, int(capacity))
    refund_fraction = _clamp(float(refund_rate), 0.0, 1.0)

    cancelled_events = [event for event in events if event.will_cancel]
    no_show_events = [
        event for event in events
        if not event.will_cancel and event.will_no_show
    ]
    live_events = [
        event for event in events
        if not event.will_cancel and not event.will_no_show
    ]

    cancelled_gross = sum(event.fare * event.party_size for event in cancelled_events)
    cancelled_refunds = cancelled_gross * refund_fraction
    cancelled_net = cancelled_gross - cancelled_refunds
    cancelled_seats = sum(event.party_size for event in cancelled_events)

    no_show_gross = sum(event.fare * event.party_size for event in no_show_events)
    no_show_seats = sum(event.party_size for event in no_show_events)

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
    accepted = cancelled_seats + no_show_seats + best_used
    total_requested = sum(event.party_size for event in events)
    gross_revenue = cancelled_gross + no_show_gross + live_revenue

    return PolicyOutcome(
        revenue=cancelled_net + no_show_gross + live_revenue,
        accepted=accepted,
        rejected=max(0, total_requested - accepted),
        empty_seats=max(0, physical_capacity - best_used),
        load_factor=best_used / physical_capacity if physical_capacity else 0.0,
        average_accepted_fare=gross_revenue / accepted if accepted else 0.0,
        boarded=best_used,
        cancelled=cancelled_seats,
        no_show=no_show_seats,
        denied_boarding=0,
        refunds=cancelled_refunds,
        gross_revenue=gross_revenue,
    )


def simulate_replication(
    classes: Sequence[FareDemand],
    capacity: int,
    seed: int,
    *,
    forecast_error_pct: float = 15.0,
    timing_jitter_days: float = 14.0,
    cancellation_rate: float = 0.08,
    no_show_rate: float = 0.03,
    refund_rate: float = 0.70,
    overbooking_pct: float = 5.0,
) -> dict[str, PolicyOutcome]:
    """Simulate one replication under an imperfect forecast."""
    physical_capacity = max(1, int(capacity))
    booking_limit = physical_capacity + round(
        physical_capacity * _clamp(float(overbooking_pct), 0.0, 30.0) / 100.0
    )

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
        no_show_rate=no_show_rate,
    )

    kwargs = dict(
        booking_limit=booking_limit,
        refund_rate=refund_rate,
        bump_compensation=BUMP_COMPENSATION,
    )
    open_result = run_policy(
        events,
        physical_capacity,
        lambda _event, _remaining: True,
        **kwargs,
    )
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
    clair = clairvoyant_upper_bound(
        events,
        physical_capacity,
        refund_rate=refund_rate,
    )

    return {
        "open": open_result,
        "emsr": emsr_result,
        "dp": dp_result,
        "clairvoyant": clair,
    }
