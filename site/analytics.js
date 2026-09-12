(() => {
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const yieldPerMile = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}¢/mi` : '—';

  const numberOrNull = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function normalizeMarket(m) {
    const passengers = numberOrNull(m.passengers) ?? 0;
    const avgFare = numberOrNull(m.avgFare) ?? 0;
    const avgDistance = numberOrNull(m.avgDistance);
    const distanceCoverage = numberOrNull(m.distanceCoverage) ?? 0;
    const enrichedYield = numberOrNull(m.yieldPerMile);
    const topCarriers = Array.isArray(m.topCarriers) ? m.topCarriers.map(row => ({
      carrier: String(row.carrier || 'Unknown'),
      passengers: numberOrNull(row.passengers) ?? 0,
      share: numberOrNull(row.share) ?? 0,
    })) : [];
    const monthly = Array.isArray(m.monthly) ? m.monthly.map(point => {
      const pointFare = numberOrNull(point.avgFare) ?? 0;
      const pointDistance = numberOrNull(point.avgDistance) ?? avgDistance;
      const pointCoverage = numberOrNull(point.distanceCoverage) ?? (pointDistance ? distanceCoverage || 1 : 0);
      const pointYield = numberOrNull(point.yieldPerMile);
      return {
        ...point,
        passengers: numberOrNull(point.passengers) ?? 0,
        avgFare: pointFare,
        avgDistance: pointDistance,
        distanceCoverage: pointCoverage,
        yieldPerMile: pointYield ?? (pointDistance && pointDistance > 0 ? pointFare / pointDistance : null),
        records: numberOrNull(point.records) ?? 0,
        carriers: numberOrNull(point.carriers) ?? 0,
      };
    }) : [];
    return {
      ...m,
      passengers,
      avgFare,
      carriers: numberOrNull(m.carriers) ?? 0,
      records: numberOrNull(m.records) ?? 0,
      monthsObserved: numberOrNull(m.monthsObserved),
      revenueProxy: passengers * avgFare,
      avgDistance,
      distanceCoverage,
      yieldPerMile: enrichedYield ?? (avgDistance && avgDistance > 0 ? avgFare / avgDistance : null),
      topCarriers,
      topCarrierShare: topCarriers[0]?.share ?? null,
      carrierCoverage: numberOrNull(m.carrierCoverage) ?? 0,
      monthly,
    };
  }

  async function loadMarkets() {
    const candidates = [
      { path: 'data/market_summary.json', source: 'DB1C-derived market summary' },
      { path: 'data/demo_markets.json', source: 'demo scenarios' },
    ];
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.path);
        if (!response.ok) continue;
        const raw = await response.json();
        if (!Array.isArray(raw) || raw.length === 0) continue;
        return { markets: raw.map(normalizeMarket), source: candidate.source, isDemo: candidate.path.includes('demo_') };
      } catch (error) {
        console.warn(`Could not load ${candidate.path}`, error);
      }
    }
    throw new Error('Could not load AeroYield market data.');
  }

  function median(values) {
    const clean = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!clean.length) return 0;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  }

  function quantile(values, q) {
    const clean = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!clean.length) return 0;
    const position = (clean.length - 1) * q;
    const base = Math.floor(position);
    const rest = position - base;
    return clean[base + 1] === undefined ? clean[base] : clean[base] + rest * (clean[base + 1] - clean[base]);
  }

  function percentileRank(values, value) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length || !Number.isFinite(value)) return 0;
    return clean.filter(v => v <= value).length / clean.length;
  }

  function rankBy(markets, valueFn, selected) {
    const sorted = markets.slice().sort((a, b) => valueFn(b) - valueFn(a));
    return sorted.findIndex(m => routeKey(m) === routeKey(selected)) + 1;
  }

  function routeKey(m) {
    return `${String(m.origin || '').toUpperCase()}-${String(m.destination || '').toUpperCase()}`;
  }

  function routeHref(m) {
    return `route.html?route=${encodeURIComponent(routeKey(m))}`;
  }

  function standardDeviation(values) {
    const clean = values.filter(Number.isFinite);
    if (clean.length < 2) return 0;
    const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
    return Math.sqrt(clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length);
  }

  function fareVolatility(market) {
    const fares = (market.monthly || []).map(point => point.avgFare).filter(value => Number.isFinite(value) && value > 0);
    if (fares.length < 2) return 0;
    const mean = fares.reduce((sum, value) => sum + value, 0) / fares.length;
    return mean ? standardDeviation(fares) / mean : 0;
  }

  function opportunityScore(markets, market) {
    const values = markets.map(m => m.revenueProxy);
    const volumes = markets.map(m => m.passengers);
    const volatilities = markets.map(fareVolatility);
    const carrierCounts = markets.map(m => m.carriers);
    const valuePct = percentileRank(values, market.revenueProxy);
    const volumePct = percentileRank(volumes, market.passengers);
    const volatilityPct = percentileRank(volatilities, fareVolatility(market));
    const carrierPct = percentileRank(carrierCounts, market.carriers);
    return Math.round(100 * (0.50 * valuePct + 0.25 * volumePct + 0.15 * volatilityPct + 0.10 * carrierPct));
  }

  function networkMonthly(markets) {
    const periods = new Map();
    markets.forEach(market => {
      (market.monthly || []).forEach(point => {
        if (!point.month) return;
        const row = periods.get(point.month) || { month: point.month, passengers: 0, farePassengers: 0, yieldFarePassengers: 0, passengerMiles: 0 };
        row.passengers += point.passengers;
        row.farePassengers += point.passengers * point.avgFare;
        const distance = point.avgDistance;
        const coverage = Number.isFinite(point.distanceCoverage) ? point.distanceCoverage : (distance ? 1 : 0);
        const coveredPassengers = point.passengers * coverage;
        if (distance && distance > 0 && Number.isFinite(point.yieldPerMile) && coveredPassengers > 0) {
          const pointPassengerMiles = coveredPassengers * distance;
          row.passengerMiles += pointPassengerMiles;
          row.yieldFarePassengers += point.yieldPerMile * pointPassengerMiles;
        }
        periods.set(point.month, row);
      });
    });
    return [...periods.values()].sort((a, b) => a.month.localeCompare(b.month)).map(row => ({
      month: row.month,
      passengers: row.passengers,
      avgFare: row.passengers ? row.farePassengers / row.passengers : 0,
      yieldPerMile: row.passengerMiles ? row.yieldFarePassengers / row.passengerMiles : null,
    }));
  }

  function networkSummary(markets) {
    const totalPassengers = markets.reduce((sum, m) => sum + m.passengers, 0);
    const totalRevenueProxy = markets.reduce((sum, m) => sum + m.revenueProxy, 0);
    let distancePassengers = 0;
    let passengerMiles = 0;
    let yieldFarePassengers = 0;
    markets.forEach(m => {
      if (!m.avgDistance || !Number.isFinite(m.yieldPerMile)) return;
      const coveredPassengers = m.passengers * (Number.isFinite(m.distanceCoverage) ? m.distanceCoverage : 1);
      const routePassengerMiles = coveredPassengers * m.avgDistance;
      distancePassengers += coveredPassengers;
      passengerMiles += routePassengerMiles;
      yieldFarePassengers += m.yieldPerMile * routePassengerMiles;
    });
    const sortedByPassengers = markets.slice().sort((a, b) => b.passengers - a.passengers);
    const sortedByRevenue = markets.slice().sort((a, b) => b.revenueProxy - a.revenueProxy);
    const sortedByOpportunity = markets.slice().sort((a, b) => opportunityScore(markets, b) - opportunityScore(markets, a));
    const top10Passengers = sortedByPassengers.slice(0, 10).reduce((sum, m) => sum + m.passengers, 0);
    return {
      routeCount: markets.length,
      totalPassengers,
      totalRevenueProxy,
      weightedFare: totalPassengers ? totalRevenueProxy / totalPassengers : 0,
      weightedDistance: distancePassengers ? passengerMiles / distancePassengers : null,
      networkYield: passengerMiles ? yieldFarePassengers / passengerMiles : null,
      medianFare: median(markets.map(m => m.avgFare)),
      fareQ1: quantile(markets.map(m => m.avgFare), 0.25),
      fareQ3: quantile(markets.map(m => m.avgFare), 0.75),
      medianPassengers: median(markets.map(m => m.passengers)),
      medianCarriers: median(markets.map(m => m.carriers)),
      top10PassengerShare: totalPassengers ? top10Passengers / totalPassengers : 0,
      topVolume: sortedByPassengers[0] || null,
      topRevenue: sortedByRevenue[0] || null,
      topOpportunity: sortedByOpportunity[0] || null,
      monthsObserved: Math.max(...markets.map(m => m.monthsObserved || 0), 0),
    };
  }

  function signedPercent(value) {
    if (!Number.isFinite(value)) return '—';
    const abs = percent.format(Math.abs(value));
    return value > 0 ? `+${abs}` : value < 0 ? `−${abs}` : '0%';
  }

  window.AeroYieldData = {
    loadMarkets,
    median,
    quantile,
    percentileRank,
    rankBy,
    routeKey,
    routeHref,
    standardDeviation,
    fareVolatility,
    opportunityScore,
    networkMonthly,
    networkSummary,
    signedPercent,
    format: { money, integer, decimal, compactMoney, percent, yieldPerMile },
  };
})();
