(() => {
  const RM = window.AeroYieldRM;
  const DAYS = 180;
  const SLOTS_PER_DAY = 4;
  const PERIODS = (DAYS + 1) * SLOTS_PER_DAY;

  function makeRng(seed) {
    let state = Number(seed) >>> 0;
    return () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function classProfile(name, progress) {
    if (name === 'Saver') return Math.max(0.15, 1.0 - 0.75 * progress);
    if (name === 'Main') return 0.75 + 0.10 * progress;
    return 0.20 + 0.80 * Math.pow(progress, 1.8);
  }

  function routeClasses(market) {
    return [
      { name: 'Saver', fare: Number(market.saverFare || 0), meanDemand: Number(market.saverDemand || 0) },
      { name: 'Main', fare: Number(market.mainFare || 0), meanDemand: Number(market.mainDemand || 0) },
      { name: 'Flex', fare: Number(market.flexFare || 0), meanDemand: Number(market.flexDemand || 0) },
    ];
  }

  function buildScenario(market, capacity = market.capacity) {
    const classes = routeClasses(market);
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

    const probabilities = Array.from({ length: PERIODS }, (_, period) => {
      const row = {};
      let total = 0;
      for (const fc of classes) {
        const p = fc.meanDemand <= 0 ? 0 : fc.meanDemand * profiles[fc.name][period] / totals[fc.name];
        row[fc.name] = p;
        total += p;
      }
      if (total > 1 + 1e-10) {
        throw new Error(`Modeled demand is too concentrated for the one-request-per-slot model (max probability ${total.toFixed(3)}). Increase booking slots.`);
      }
      return row;
    });

    return {
      market,
      capacity: Math.max(1, Math.floor(Number(capacity) || 1)),
      classes,
      fares: Object.fromEntries(classes.map(fc => [fc.name, fc.fare])),
      probabilities,
      periods: PERIODS,
      days: DAYS,
      slotsPerDay: SLOTS_PER_DAY,
    };
  }

  function generateStream(scenario, seed) {
    const rand = makeRng(seed);
    const events = [];
    for (let period = 0; period < scenario.periods; period++) {
      const probabilities = scenario.probabilities[period];
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
      if (selected) {
        events.push({
          period,
          day: DAYS - Math.floor(period / SLOTS_PER_DAY),
          name: selected.name,
          fare: selected.fare,
        });
      }
    }
    return events;
  }

  function runPolicy(events, scenario, acceptFn, captureHistory = false) {
    let remaining = scenario.capacity;
    let revenue = 0;
    let accepted = 0;
    let rejected = 0;
    const byClass = {};
    const history = captureHistory ? [{ period: -1, day: DAYS, revenue: 0, accepted: 0 }] : null;
    let eventIndex = 0;

    for (let period = 0; period < scenario.periods; period++) {
      while (eventIndex < events.length && events[eventIndex].period === period) {
        const event = events[eventIndex];
        const shouldAccept = remaining > 0 && acceptFn(event, remaining, period);
        if (shouldAccept) {
          remaining -= 1;
          accepted += 1;
          revenue += event.fare;
          byClass[event.name] = (byClass[event.name] || 0) + 1;
        } else {
          rejected += 1;
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

    return {
      revenue,
      accepted,
      rejected,
      emptySeats: remaining,
      loadFactor: scenario.capacity ? accepted / scenario.capacity : 0,
      averageAcceptedFare: accepted ? revenue / accepted : 0,
      byClass,
      history,
    };
  }

  function summarizeRows(rows, clairRows, capacity) {
    const n = Math.max(rows.length, 1);
    const sum = key => rows.reduce((total, row) => total + row[key], 0);
    const avgRevenue = sum('revenue') / n;
    return {
      averageRevenue: avgRevenue,
      averageAccepted: sum('accepted') / n,
      averageRejected: sum('rejected') / n,
      averageEmptySeats: sum('emptySeats') / n,
      averageLoadFactor: capacity ? (sum('accepted') / n) / capacity : 0,
      averageAcceptedFare: rows.reduce((total, row) => total + row.revenue, 0) / Math.max(rows.reduce((total, row) => total + row.accepted, 0), 1),
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

  function runExperiment({ market, capacity = market.capacity, replications = 500, seed = 20260912 }) {
    const scenario = buildScenario(market, capacity);
    const emsr = RM.emsrB(scenario.capacity, scenario.classes);
    const dp = RM.buildDP(scenario.capacity, scenario.fares, scenario.probabilities);
    const runs = { open: [], emsr: [], dp: [], clairvoyant: [] };
    let representative = null;

    const count = Math.max(1, Math.floor(Number(replications) || 1));
    const baseSeed = Number(seed) >>> 0;
    for (let rep = 0; rep < count; rep++) {
      const repSeed = (baseSeed + Math.imul(rep, 0x9e3779b9)) >>> 0;
      const events = generateStream(scenario, repSeed);
      const capture = rep === 0;

      const open = runPolicy(events, scenario, () => true, capture);
      const emsrRun = runPolicy(events, scenario, (event, remaining) => RM.emsrAccept(emsr, event.name, remaining), capture);
      const dpRun = runPolicy(events, scenario, (event, remaining, period) => dp.accept(period, remaining, event.fare), capture);
      const clair = RM.clairvoyant(scenario.capacity, events);
      const clairRun = {
        revenue: clair.revenue,
        accepted: clair.accepted,
        rejected: Math.max(0, events.length - clair.accepted),
        emptySeats: Math.max(0, scenario.capacity - clair.accepted),
        loadFactor: scenario.capacity ? clair.accepted / scenario.capacity : 0,
        averageAcceptedFare: clair.accepted ? clair.revenue / clair.accepted : 0,
        byClass: clair.byClass,
      };

      runs.open.push(open);
      runs.emsr.push(emsrRun);
      runs.dp.push(dpRun);
      runs.clairvoyant.push(clairRun);
      if (capture) representative = { events, open, emsr: emsrRun, dp: dpRun, clairvoyant: clairRun };
    }

    const summaries = {
      open: addDistribution(summarizeRows(runs.open, runs.clairvoyant, scenario.capacity)),
      emsr: addDistribution(summarizeRows(runs.emsr, runs.clairvoyant, scenario.capacity)),
      dp: addDistribution(summarizeRows(runs.dp, runs.clairvoyant, scenario.capacity)),
      clairvoyant: addDistribution(summarizeRows(runs.clairvoyant, null, scenario.capacity)),
    };

    return {
      scenario,
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
    makeRng,
    routeClasses,
    buildScenario,
    generateStream,
    runPolicy,
    quantile,
    runExperiment,
  };
})();
