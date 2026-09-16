(() => {
  const RM = window.AeroYieldRM;
  const DAYS = 180;
  const SLOTS_PER_DAY = 4;
  const PERIODS = (DAYS + 1) * SLOTS_PER_DAY;
  const PARTY_SIZE_PROBABILITIES = [
    [1, 0.84],
    [2, 0.12],
    [3, 0.03],
    [4, 0.01],
  ];
  const EXPECTED_PARTY_SIZE = PARTY_SIZE_PROBABILITIES.reduce((sum, [size, probability]) => sum + size * probability, 0);
  const BUMP_COMPENSATION = 400;

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function makeRng(seed) {
    let state = Number(seed) >>> 0;
    return () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function classProfile(name, progress) {
    const p = clamp(progress, 0, 1);
    if (name === 'Saver') return Math.max(0.15, 1.0 - 0.75 * p);
    if (name === 'Main') return 0.75 + 0.10 * p;
    return 0.20 + 0.80 * Math.pow(p, 1.8);
  }

  function routeClasses(market) {
    return [
      { name: 'Saver', fare: Number(market.saverFare || 0), meanDemand: Number(market.saverDemand || 0) },
      { name: 'Main', fare: Number(market.mainFare || 0), meanDemand: Number(market.mainDemand || 0) },
      { name: 'Flex', fare: Number(market.flexFare || 0), meanDemand: Number(market.flexDemand || 0) },
    ];
  }

  function buildForecastProbabilities(classes) {
    const profiles = Object.fromEntries(classes.map(fc => [fc.name, []]));
    const totals = Object.fromEntries(classes.map(fc => [fc.name, 0]));

    for (let period = 0; period < PERIODS; period++) {
      const day = DAYS - Math.floor(period / SLOTS_PER_DAY);
      const progress = (DAYS - day) / DAYS;
      for (const fc of classes) {
        const weight = classProfile(fc.name, progress);
        profiles[fc.name].push(weight);
        totals[fc.name] += weight;
      }
    }

    return Array.from({ length: PERIODS }, (_, period) => {
      const row = {};
      let total = 0;
      for (const fc of classes) {
        const p = fc.meanDemand <= 0 ? 0 : fc.meanDemand * profiles[fc.name][period] / totals[fc.name];
        row[fc.name] = p;
        total += p;
      }
      if (total > 1 + 1e-10) {
        throw new Error(`Forecast demand is too concentrated for the one-request-per-slot DP model (max probability ${total.toFixed(3)}).`);
      }
      return row;
    });
  }

  function buildScenario(market, capacity = market.capacity, options = {}) {
    const classes = routeClasses(market);
    const physicalCapacity = Math.max(1, Math.floor(Number(capacity) || 1));
    const overbookPct = clamp(Number(options.overbookPct ?? 5), 0, 30);
    const bookingLimit = physicalCapacity + Math.round(physicalCapacity * overbookPct / 100);
    const probabilities = buildForecastProbabilities(classes);

    return {
      market,
      capacity: physicalCapacity,
      physicalCapacity,
      bookingLimit,
      overbookPct,
      classes,
      fares: Object.fromEntries(classes.map(fc => [fc.name, fc.fare])),
      probabilities,
      forecastProbabilities: probabilities,
      periods: PERIODS,
      days: DAYS,
      slotsPerDay: SLOTS_PER_DAY,
    };
  }

  function buildRealizedProbabilities(scenario, rand, options = {}) {
    const forecastErrorPct = clamp(Number(options.forecastErrorPct ?? 15), 0, 60);
    const timingJitterDays = clamp(Number(options.timingJitterDays ?? 14), 0, 60);
    const error = forecastErrorPct / 100;
    const weights = {};
    const targets = {};
    const perturbations = {};

    for (const fc of scenario.classes) {
      const demandMultiplier = Math.max(0.25, 1 + (2 * rand() - 1) * error);
      const shiftDays = (2 * rand() - 1) * timingJitterDays;
      const dayNoise = Array.from({ length: DAYS + 1 }, () =>
        Math.max(0.20, 1 + (2 * rand() - 1) * Math.max(0.05, error))
      );

      const classWeights = [];
      for (let period = 0; period < PERIODS; period++) {
        const day = DAYS - Math.floor(period / SLOTS_PER_DAY);
        const shiftedProgress = (DAYS - day - shiftDays) / DAYS;
        classWeights.push(classProfile(fc.name, shiftedProgress) * dayNoise[DAYS - day]);
      }
      weights[fc.name] = classWeights;
      targets[fc.name] = Math.max(0, fc.meanDemand * demandMultiplier / EXPECTED_PARTY_SIZE);
      perturbations[fc.name] = {
        demandMultiplier,
        timingShiftDays: shiftDays,
      };
    }

    const totals = Object.fromEntries(Object.entries(weights).map(([name, values]) => [
      name,
      values.reduce((sum, value) => sum + value, 0),
    ]));

    const probabilities = Array.from({ length: PERIODS }, (_, period) => {
      const row = {};
      for (const fc of scenario.classes) {
        row[fc.name] = targets[fc.name] <= 0 ? 0 : targets[fc.name] * weights[fc.name][period] / totals[fc.name];
      }
      const total = Object.values(row).reduce((sum, value) => sum + value, 0);
      if (total > 0.98) {
        const scale = 0.98 / total;
        Object.keys(row).forEach(name => { row[name] *= scale; });
      }
      return row;
    });

    return { probabilities, perturbations };
  }

  function samplePartySize(rand) {
    const draw = rand();
    let cumulative = 0;
    for (const [size, probability] of PARTY_SIZE_PROBABILITIES) {
      cumulative += probability;
      if (draw < cumulative) return size;
    }
    return PARTY_SIZE_PROBABILITIES[PARTY_SIZE_PROBABILITIES.length - 1][0];
  }

  function generateRealization(scenario, seed, options = {}) {
    const truthRand = makeRng((Number(seed) ^ 0xA5A5A5A5) >>> 0);
    const realized = buildRealizedProbabilities(scenario, truthRand, options);

    const rand = makeRng(seed);
    const cancellationRate = clamp(Number(options.cancellationRate ?? 8), 0, 50) / 100;
    const events = [];

    for (let period = 0; period < scenario.periods; period++) {
      const probabilities = realized.probabilities[period];
      const r = rand();
      let cumulative = 0;
      let selected = null;
      for (const fc of scenario.classes) {
        cumulative += probabilities[fc.name] || 0;
        if (r < cumulative) {
          selected = fc;
          break;
        }
      }
      if (!selected) continue;

      const partySize = samplePartySize(rand);
      const willCancel = rand() < cancellationRate && period < scenario.periods - 1;
      let cancelPeriod = null;
      if (willCancel) {
        const remaining = scenario.periods - period - 1;
        cancelPeriod = period + 1 + Math.min(remaining - 1, Math.floor(rand() * remaining));
      }

      events.push({
        id: events.length,
        period,
        day: DAYS - Math.floor(period / SLOTS_PER_DAY),
        name: selected.name,
        fare: selected.fare,
        partySize,
        willCancel,
        cancelPeriod,
      });
    }

    return {
      events,
      trueProbabilities: realized.probabilities,
      perturbations: realized.perturbations,
    };
  }

  function generateStream(scenario, seed, options = {}) {
    return generateRealization(scenario, seed, options).events;
  }

  function emsrAcceptGroup(emsr, event, remaining) {
    if (event.partySize > remaining) return false;
    const protection = Number(emsr.protection[event.name] || 0);
    return remaining - event.partySize >= protection;
  }

  function dpAcceptGroup(dp, event, remaining, period) {
    if (event.partySize > remaining || remaining <= 0) return false;
    let opportunityCost = 0;
    for (let offset = 0; offset < event.partySize; offset++) {
      const c = Math.max(1, Math.min(dp.bidPrices[period].length - 1, remaining - offset));
      opportunityCost += Number(dp.bidPrices[period][c] || 0);
    }
    return event.fare * event.partySize + 1e-12 >= opportunityCost;
  }

  function runPolicy(events, scenario, acceptFn, captureHistory = false, options = {}) {
    const refundFraction = clamp(Number(options.refundRate ?? 70), 0, 100) / 100;
    const bookingLimit = scenario.bookingLimit;
    const active = new Map();
    const cancellationsByPeriod = new Map();

    for (const event of events) {
      if (event.cancelPeriod == null) continue;
      if (!cancellationsByPeriod.has(event.cancelPeriod)) cancellationsByPeriod.set(event.cancelPeriod, []);
      cancellationsByPeriod.get(event.cancelPeriod).push(event.id);
    }

    let activeSeats = 0;
    let grossRevenue = 0;
    let revenue = 0;
    let accepted = 0;
    let rejected = 0;
    let cancelledSeats = 0;
    let refunds = 0;
    const byClass = {};
    const history = captureHistory ? [{ period: -1, day: DAYS, revenue: 0, accepted: 0 }] : null;
    let eventIndex = 0;

    for (let period = 0; period < scenario.periods; period++) {
      for (const eventId of cancellationsByPeriod.get(period) || []) {
        const event = active.get(eventId);
        if (!event) continue;
        active.delete(eventId);
        activeSeats -= event.partySize;
        cancelledSeats += event.partySize;
        const refund = event.fare * event.partySize * refundFraction;
        refunds += refund;
        revenue -= refund;
      }

      while (eventIndex < events.length && events[eventIndex].period === period) {
        const event = events[eventIndex];
        const remaining = bookingLimit - activeSeats;
        const shouldAccept = event.partySize <= remaining && acceptFn(event, remaining, period);
        if (shouldAccept) {
          active.set(event.id, event);
          activeSeats += event.partySize;
          accepted += event.partySize;
          const sale = event.fare * event.partySize;
          grossRevenue += sale;
          revenue += sale;
          byClass[event.name] = (byClass[event.name] || 0) + event.partySize;
        } else {
          rejected += event.partySize;
        }
        eventIndex += 1;
      }

      if (captureHistory && (period % SLOTS_PER_DAY === SLOTS_PER_DAY - 1 || period === scenario.periods - 1)) {
        history.push({
          period,
          day: DAYS - Math.floor(period / SLOTS_PER_DAY),
          revenue,
          accepted,
        });
      }
    }

    const deniedSeats = Math.max(0, activeSeats - scenario.capacity);
    const boarded = Math.min(activeSeats, scenario.capacity);

    if (deniedSeats > 0) {
      const activeSeatFares = [];
      active.forEach(event => {
        for (let i = 0; i < event.partySize; i++) activeSeatFares.push(event.fare);
      });
      activeSeatFares.sort((a, b) => a - b);
      const deniedRefunds = activeSeatFares.slice(0, deniedSeats).reduce((sum, fare) => sum + fare, 0);
      refunds += deniedRefunds;
      revenue -= deniedRefunds + deniedSeats * BUMP_COMPENSATION;
    }

    const emptySeats = Math.max(0, scenario.capacity - boarded);
    if (captureHistory && history.length) {
      history[history.length - 1].revenue = revenue;
      history[history.length - 1].accepted = accepted;
    }

    return {
      revenue,
      grossRevenue,
      refunds,
      accepted,
      boarded,
      rejected,
      cancelledSeats,
      deniedSeats,
      emptySeats,
      loadFactor: scenario.capacity ? boarded / scenario.capacity : 0,
      averageAcceptedFare: accepted ? grossRevenue / accepted : 0,
      byClass,
      history,
    };
  }

  function clairvoyantUpperBound(events, scenario, options = {}) {
    const refundFraction = clamp(Number(options.refundRate ?? 70), 0, 100) / 100;
    const cancelled = events.filter(event => event.willCancel);
    const live = events.filter(event => !event.willCancel);

    const cancelledGross = cancelled.reduce((sum, event) => sum + event.fare * event.partySize, 0);
    const cancelledRefunds = cancelledGross * refundFraction;
    const cancelledNet = cancelledGross - cancelledRefunds;
    const cancelledSeats = cancelled.reduce((sum, event) => sum + event.partySize, 0);

    const capacity = scenario.capacity;
    const best = Array(capacity + 1).fill(-Infinity);
    best[0] = 0;

    for (const event of live) {
      const size = event.partySize;
      const value = event.fare * size;
      for (let used = capacity; used >= size; used--) {
        if (Number.isFinite(best[used - size])) {
          best[used] = Math.max(best[used], best[used - size] + value);
        }
      }
    }

    let boarded = 0;
    for (let used = 1; used <= capacity; used++) {
      if (best[used] > best[boarded]) boarded = used;
    }
    const liveRevenue = Math.max(0, best[boarded]);
    const accepted = cancelledSeats + boarded;
    const totalRequested = events.reduce((sum, event) => sum + event.partySize, 0);
    const grossRevenue = cancelledGross + liveRevenue;

    return {
      revenue: cancelledNet + liveRevenue,
      grossRevenue,
      refunds: cancelledRefunds,
      accepted,
      boarded,
      rejected: Math.max(0, totalRequested - accepted),
      cancelledSeats,
      deniedSeats: 0,
      emptySeats: Math.max(0, capacity - boarded),
      loadFactor: capacity ? boarded / capacity : 0,
      averageAcceptedFare: accepted ? grossRevenue / accepted : 0,
      byClass: {},
      history: null,
    };
  }

  function summarizeRows(rows, clairRows) {
    const n = Math.max(rows.length, 1);
    const sum = key => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const totalAccepted = sum('accepted');
    const totalGross = sum('grossRevenue');
    return {
      averageRevenue: sum('revenue') / n,
      averageAccepted: totalAccepted / n,
      averageBoarded: sum('boarded') / n,
      averageRejected: sum('rejected') / n,
      averageCancelled: sum('cancelledSeats') / n,
      averageDenied: sum('deniedSeats') / n,
      averageRefunds: sum('refunds') / n,
      averageEmptySeats: sum('emptySeats') / n,
      averageLoadFactor: rows.reduce((total, row) => total + row.loadFactor, 0) / n,
      averageAcceptedFare: totalAccepted ? totalGross / totalAccepted : 0,
      averageRegret: clairRows ? clairRows.reduce((total, clair, i) => total + (clair.revenue - rows[i].revenue), 0) / n : 0,
      revenues: rows.map(row => row.revenue),
    };
  }

  function quantile(values, q) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function addDistribution(summary) {
    return {
      ...summary,
      p10: quantile(summary.revenues, 0.10),
      p50: quantile(summary.revenues, 0.50),
      p90: quantile(summary.revenues, 0.90),
    };
  }

  function runExperiment({
    market,
    capacity = market.capacity,
    replications = 500,
    seed = 20260912,
    forecastErrorPct = 15,
    timingJitterDays = 14,
    cancellationRate = 8,
    refundRate = 70,
    overbookPct = 5,
  }) {
    const assumptions = {
      forecastErrorPct: clamp(Number(forecastErrorPct), 0, 60),
      timingJitterDays: clamp(Number(timingJitterDays), 0, 60),
      cancellationRate: clamp(Number(cancellationRate), 0, 50),
      refundRate: clamp(Number(refundRate), 0, 100),
      overbookPct: clamp(Number(overbookPct), 0, 30),
    };

    const scenario = buildScenario(market, capacity, assumptions);
    const emsr = RM.emsrB(scenario.bookingLimit, scenario.classes);
    const dp = RM.buildDP(scenario.bookingLimit, scenario.fares, scenario.forecastProbabilities);
    const runs = { open: [], emsr: [], dp: [], clairvoyant: [] };
    let representative = null;

    const count = Math.max(1, Math.floor(Number(replications) || 1));
    const baseSeed = Number(seed) >>> 0;
    for (let rep = 0; rep < count; rep++) {
      const repSeed = (baseSeed + Math.imul(rep, 0x9e3779b9)) >>> 0;
      const realization = generateRealization(scenario, repSeed, assumptions);
      const events = realization.events;
      const capture = rep === 0;

      const open = runPolicy(events, scenario, () => true, capture, assumptions);
      const emsrRun = runPolicy(
        events,
        scenario,
        (event, remaining) => emsrAcceptGroup(emsr, event, remaining),
        capture,
        assumptions
      );
      const dpRun = runPolicy(
        events,
        scenario,
        (event, remaining, period) => dpAcceptGroup(dp, event, remaining, period),
        capture,
        assumptions
      );
      const clair = clairvoyantUpperBound(events, scenario, assumptions);

      runs.open.push(open);
      runs.emsr.push(emsrRun);
      runs.dp.push(dpRun);
      runs.clairvoyant.push(clair);
      if (capture) representative = {
        events,
        perturbations: realization.perturbations,
        open,
        emsr: emsrRun,
        dp: dpRun,
        clairvoyant: clair,
      };
    }

    const summaries = {
      open: addDistribution(summarizeRows(runs.open, runs.clairvoyant)),
      emsr: addDistribution(summarizeRows(runs.emsr, runs.clairvoyant)),
      dp: addDistribution(summarizeRows(runs.dp, runs.clairvoyant)),
      clairvoyant: addDistribution(summarizeRows(runs.clairvoyant, null)),
    };

    return {
      scenario,
      assumptions,
      emsr,
      dp,
      summaries,
      representative,
      replications: count,
      seed: baseSeed,
    };
  }

  window.AeroYieldSimulation = {
    DAYS,
    SLOTS_PER_DAY,
    PERIODS,
    PARTY_SIZE_PROBABILITIES,
    EXPECTED_PARTY_SIZE,
    BUMP_COMPENSATION,
    makeRng,
    routeClasses,
    buildScenario,
    buildRealizedProbabilities,
    generateStream,
    runPolicy,
    quantile,
    runExperiment,
  };
})();
