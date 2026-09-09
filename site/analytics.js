(() => {
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

  const numberOrNull = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function normalizeMarket(m) {
    const passengers = numberOrNull(m.passengers) ?? 0;
    const avgFare = numberOrNull(m.avgFare) ?? 0;
    const avgDistance = numberOrNull(m.avgDistance);
    return {
      ...m,
      passengers,
      avgFare,
      carriers: numberOrNull(m.carriers) ?? 0,
      records: numberOrNull(m.records) ?? 0,
      monthsObserved: numberOrNull(m.monthsObserved),
      revenueProxy: passengers * avgFare,
      avgDistance,
      yieldPerMile: avgDistance && avgDistance > 0 ? avgFare / avgDistance : null,
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
    if (!clean.length) return 0;
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

  function networkSummary(markets) {
    const totalPassengers = markets.reduce((sum, m) => sum + m.passengers, 0);
    const totalRevenueProxy = markets.reduce((sum, m) => sum + m.revenueProxy, 0);
    const sortedByPassengers = markets.slice().sort((a, b) => b.passengers - a.passengers);
    const sortedByRevenue = markets.slice().sort((a, b) => b.revenueProxy - a.revenueProxy);
    const top10Passengers = sortedByPassengers.slice(0, 10).reduce((sum, m) => sum + m.passengers, 0);
    return {
      routeCount: markets.length,
      totalPassengers,
      totalRevenueProxy,
      weightedFare: totalPassengers ? totalRevenueProxy / totalPassengers : 0,
      medianFare: median(markets.map(m => m.avgFare)),
      fareQ1: quantile(markets.map(m => m.avgFare), 0.25),
      fareQ3: quantile(markets.map(m => m.avgFare), 0.75),
      medianPassengers: median(markets.map(m => m.passengers)),
      medianCarriers: median(markets.map(m => m.carriers)),
      top10PassengerShare: totalPassengers ? top10Passengers / totalPassengers : 0,
      topVolume: sortedByPassengers[0] || null,
      topRevenue: sortedByRevenue[0] || null,
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
    networkSummary,
    signedPercent,
    format: { money, integer, compactMoney, percent },
  };
})();
