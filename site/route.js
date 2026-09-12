const AY = window.AeroYieldData;
const state = { markets: [], viewMarkets: [], summary: null, source: '', isDemo: false, selected: null, selectedMonth: 'all', trendMetric: 'passengers' };

function findInitialRoute(markets) {
  const requested = new URLSearchParams(window.location.search).get('route');
  if (requested) {
    const normalized = requested.toUpperCase().replace(/→/g, '-').replace(/\s+/g, '');
    const found = markets.find(m => AY.routeKey(m) === normalized);
    if (found) return found;
  }
  return markets.slice().sort((a, b) => b.revenueProxy - a.revenueProxy)[0];
}

function rankLabel(rank, total) {
  return rank ? `#${rank} of ${total}` : '—';
}

function topPercentLabel(percentile) {
  const top = Math.max(1, Math.round((1 - percentile) * 100));
  return `Top ${top}%`;
}

function modeledValues(m) {
  const dailyDemand = m.passengers / 30;
  const scenarioDemand = Math.round(Math.max(60, Math.min(260, dailyDemand)));
  const saverDemand = Math.max(1, Math.round(scenarioDemand * 0.55));
  const mainDemand = Math.max(1, Math.round(scenarioDemand * 0.32));
  return {
    saverFare: Math.round(m.avgFare * 0.65),
    mainFare: Math.round(m.avgFare * 1.05),
    flexFare: Math.round(m.avgFare * 1.85),
    saverDemand,
    mainDemand,
    flexDemand: Math.max(1, scenarioDemand - saverDemand - mainDemand),
  };
}

function viewMarket(m) {
  if (state.selectedMonth === 'all') return m;
  const point = (m.monthly || []).find(item => item.month === state.selectedMonth);
  if (!point) return { ...m, passengers: 0, avgFare: 0, revenueProxy: 0, carriers: 0, records: 0, ...modeledValues({ ...m, passengers: 0, avgFare: 0 }) };
  const current = { ...m, ...point, revenueProxy: point.passengers * point.avgFare };
  return { ...current, ...modeledValues(current) };
}

function availableMonths() {
  return [...new Set(state.markets.flatMap(m => (m.monthly || []).map(point => point.month)))].sort();
}

function formatMonth(period) {
  const [year, month] = period.split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function renderSnapshot(m) {
  const s = state.summary;
  const fareDelta = s.weightedFare ? m.avgFare / s.weightedFare - 1 : 0;
  const volumeRank = AY.rankBy(state.viewMarkets, route => route.passengers, m);
  const revenueRank = AY.rankBy(state.viewMarkets, route => route.revenueProxy, m);
  document.title = `${m.origin} → ${m.destination} Route Detail | AeroYield`;
  document.getElementById('routeHeroTitle').textContent = `${m.origin} → ${m.destination}: route detail.`;
  document.getElementById('routeSectionTitle').textContent = `${m.origin} → ${m.destination} · ${state.selectedMonth === 'all' ? 'all observed months' : formatMonth(state.selectedMonth)}`;
  document.getElementById('routeFare').textContent = AY.format.money.format(m.avgFare);
  document.getElementById('routeFareDelta').textContent = `${AY.signedPercent(fareDelta)} vs ${AY.format.money.format(s.weightedFare)} network average`;
  document.getElementById('routePassengers').textContent = AY.format.integer.format(m.passengers);
  document.getElementById('routePassengerRank').textContent = `${rankLabel(volumeRank, state.viewMarkets.length)} by passengers`;
  document.getElementById('routeRevenue').textContent = AY.format.compactMoney.format(m.revenueProxy);
  document.getElementById('routeRevenueRank').textContent = `${rankLabel(revenueRank, state.viewMarkets.length)} by estimated market value`;
  document.getElementById('routeCarriers').textContent = AY.format.integer.format(m.carriers);
  document.getElementById('routeCarrierContext').textContent = `network median: ${AY.format.integer.format(s.medianCarriers)} reporting carriers`;
  document.getElementById('modeledRouteName').textContent = `${m.origin} → ${m.destination}`;
}

function renderBenchmarks(m) {
  const volumePct = AY.percentileRank(state.viewMarkets.map(route => route.passengers), m.passengers);
  const farePct = AY.percentileRank(state.viewMarkets.map(route => route.avgFare), m.avgFare);
  document.getElementById('volumePercentile').textContent = `${Math.round(volumePct * 100)}th`;
  document.getElementById('volumePercentileText').textContent = `${topPercentLabel(volumePct)} by observed passengers among routes shown.`;
  document.getElementById('farePercentile').textContent = `${Math.round(farePct * 100)}th`;

  const originMarkets = state.viewMarkets.filter(route => route.origin === m.origin);
  const originPassengers = originMarkets.reduce((sum, route) => sum + route.passengers, 0);
  const share = originPassengers ? m.passengers / originPassengers : 0;
  document.getElementById('originShare').textContent = AY.format.percent.format(share);
  document.getElementById('originShareText').textContent = `${AY.format.integer.format(m.passengers)} of ${AY.format.integer.format(originPassengers)} observed passengers across ${originMarkets.length} routes from ${m.origin}.`;

  const reverse = state.viewMarkets.find(route => route.origin === m.destination && route.destination === m.origin);
  document.getElementById('reverseRoute').textContent = reverse ? `${reverse.origin} → ${reverse.destination}` : 'Not shown';
  if (reverse) {
    const fareDiff = reverse.avgFare ? m.avgFare / reverse.avgFare - 1 : 0;
    const paxDiff = reverse.passengers ? m.passengers / reverse.passengers - 1 : 0;
    document.getElementById('reverseDetail').textContent = `Compared with the reverse route, average fare is ${AY.signedPercent(fareDiff)} and observed passengers are ${AY.signedPercent(paxDiff)}.`;
  } else {
    document.getElementById('reverseDetail').textContent = 'The reverse direction is not present in the current route summary.';
  }
}

function renderReadout(m) {
  const s = state.summary;
  const volumePct = AY.percentileRank(state.viewMarkets.map(route => route.passengers), m.passengers);
  const valuePct = AY.percentileRank(state.viewMarkets.map(route => route.revenueProxy), m.revenueProxy);
  const fareDelta = s.weightedFare ? m.avgFare / s.weightedFare - 1 : 0;
  const reverse = state.viewMarkets.find(route => route.origin === m.destination && route.destination === m.origin);
  const items = [];

  items.push({
    label: 'Passenger scale',
    value: `${Math.round(volumePct * 100)}th percentile`,
    text: `${topPercentLabel(volumePct)} by passenger volume. ${volumePct >= 0.75 ? 'A small improvement per passenger could matter because this is a large market.' : 'This is not one of the largest traffic pools, so expected revenue impact is likely smaller.'}`,
  });

  items.push({
    label: 'Average fare',
    value: `${AY.signedPercent(fareDelta)} vs network`,
    text: `${Math.abs(fareDelta) < 0.05 ? 'Average fare is close to the network average.' : fareDelta > 0 ? 'Average fare is above the network average.' : 'Average fare is below the network average.'} Compare yield per mile before treating a high fare as unusually strong pricing.`,
  });

  items.push({
    label: 'Estimated market value',
    value: `${Math.round(valuePct * 100)}th percentile`,
    text: `${valuePct >= 0.8 ? 'This route combines enough traffic and fare value to make it a strong candidate for seat-control experiments.' : 'This route has less total fare × passenger value, so optimization gains may have less network-wide impact.'}`,
  });

  items.push({
    label: 'Competition',
    value: `${m.carriers} reporting carriers`,
    text: `${m.carriers > s.medianCarriers ? 'More carriers than the network median suggests a broader competitive set.' : m.carriers < s.medianCarriers ? 'Fewer carriers than the network median suggests a narrower competitive set.' : 'Carrier count is near the network median.'} This is a count, not carrier market share.`,
  });

  if (reverse) {
    const fareDiff = reverse.avgFare ? Math.abs(m.avgFare / reverse.avgFare - 1) : 0;
    const paxDiff = reverse.passengers ? Math.abs(m.passengers / reverse.passengers - 1) : 0;
    items.push({
      label: 'Direction difference',
      value: `${AY.format.money.format(reverse.avgFare)} reverse average fare`,
      text: `${fareDiff > 0.08 || paxDiff > 0.08 ? 'The two directions differ enough that using one identical demand assumption for both would be questionable.' : 'The reverse market is similar enough to support a symmetric starting assumption.'}`,
    });
  }

  document.getElementById('analystReadout').innerHTML = items.map(item => `
    <div class="readout-item"><div><span>${item.label}</span><strong>${item.value}</strong></div><p>${item.text}</p></div>`).join('');

  let priority = 'Monitor';
  if (volumePct >= 0.75 && valuePct >= 0.75) priority = 'High-value test market';
  else if (valuePct >= 0.6) priority = 'Worth testing';
  document.getElementById('routePriority').textContent = priority;
}

function renderScatter(m) {
  const svg = document.getElementById('routeScatter');
  const markets = state.viewMarkets;
  const W = 760, H = 360, L = 68, R = 28, T = 26, B = 52;
  const fares = markets.map(route => route.avgFare);
  const pax = markets.map(route => route.passengers);
  const minX = Math.max(0, Math.min(...fares) * 0.9);
  const maxX = Math.max(...fares) * 1.08;
  const maxY = Math.max(...pax) * 1.08;
  const x = value => L + (value - minX) / Math.max(maxX - minX, 1) * (W - L - R);
  const y = value => H - B - value / Math.max(maxY, 1) * (H - T - B);
  let html = '';

  for (let i = 0; i <= 4; i++) {
    const yy = T + i * (H - T - B) / 4;
    const value = maxY - i * maxY / 4;
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="8" y="${yy + 4}">${Math.round(value / 1000)}k</text>`;
    const xv = minX + i * (maxX - minX) / 4;
    html += `<text class="scatter-label" x="${x(xv)}" y="${H - 16}" text-anchor="middle">$${Math.round(xv)}</text>`;
  }
  html += `<line class="scatter-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line>`;
  html += `<line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;
  html += `<line class="benchmark-line" x1="${x(state.summary.weightedFare)}" y1="${T}" x2="${x(state.summary.weightedFare)}" y2="${H - B}"></line>`;
  html += `<line class="benchmark-line" x1="${L}" y1="${y(state.summary.medianPassengers)}" x2="${W - R}" y2="${y(state.summary.medianPassengers)}"></line>`;

  markets.forEach(route => {
    const selected = AY.routeKey(route) === AY.routeKey(m);
    html += `<circle class="scatter-point ${selected ? 'active selected-route-point' : 'network-context-point'}" cx="${x(route.avgFare)}" cy="${y(route.passengers)}" r="${selected ? 10 : 4}"><title>${route.origin} → ${route.destination} · ${AY.format.money.format(route.avgFare)} average fare · ${AY.format.integer.format(route.passengers)} passengers</title></circle>`;
  });
  html += `<text class="selected-route-label" x="${Math.min(x(m.avgFare) + 13, W - 110)}" y="${Math.max(y(m.passengers) - 13, T + 15)}">${m.origin} → ${m.destination}</text>`;
  svg.innerHTML = html;
}

function renderPeers(m) {
  const peers = state.viewMarkets.filter(route => route.origin === m.origin && AY.routeKey(route) !== AY.routeKey(m)).sort((a, b) => b.revenueProxy - a.revenueProxy).slice(0, 8);
  document.getElementById('peerHeading').textContent = `What else leaves ${m.origin}?`;
  document.getElementById('peerTableBody').innerHTML = peers.map(route => {
    const delta = state.summary.weightedFare ? route.avgFare / state.summary.weightedFare - 1 : 0;
    const deltaClass = delta > 0.02 ? 'metric-up' : delta < -0.02 ? 'metric-down' : 'metric-flat';
    return `<tr>
      <td><a class="route-name-link" href="${AY.routeHref(route)}"><strong>${route.origin} → ${route.destination}</strong></a></td>
      <td>${AY.format.integer.format(route.passengers)}</td>
      <td>${AY.format.money.format(route.avgFare)}</td>
      <td><span class="metric-pill ${deltaClass}">${AY.signedPercent(delta)}</span></td>
      <td>${AY.format.integer.format(route.carriers)}</td>
      <td title="Average fare × observed passengers">${AY.format.compactMoney.format(route.revenueProxy)}</td>
      <td><a class="table-action" href="${AY.routeHref(route)}">Open →</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty-table">No other routes from this origin are present in the current summary.</td></tr>';
}

function renderModeledScenario(m) {
  const fareRows = [
    { name: 'Saver', value: Number(m.saverFare) || 0 },
    { name: 'Main', value: Number(m.mainFare) || 0 },
    { name: 'Flex', value: Number(m.flexFare) || 0 },
  ];
  const demandRows = [
    { name: 'Saver', value: Number(m.saverDemand) || 0 },
    { name: 'Main', value: Number(m.mainDemand) || 0 },
    { name: 'Flex', value: Number(m.flexDemand) || 0 },
  ];
  const maxFare = Math.max(...fareRows.map(row => row.value), 1);
  const maxDemand = Math.max(...demandRows.map(row => row.value), 1);
  document.getElementById('modeledFareBars').innerHTML = fareRows.map(row => `<div class="bar-row"><span class="bar-label">${row.name}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${100 * row.value / maxFare}%"></span></span><span class="bar-value">${AY.format.money.format(row.value)}</span></div>`).join('');
  document.getElementById('modeledDemandBars').innerHTML = demandRows.map(row => `<div class="bar-row"><span class="bar-label">${row.name}</span><span class="bar-track"><span class="bar-fill modeled-demand-fill" style="display:block;width:${100 * row.value / maxDemand}%"></span></span><span class="bar-value">${AY.format.integer.format(row.value)}</span></div>`).join('');
}

function trendValue(point, metric) {
  const modeled = modeledValues(point);
  if (metric === 'revenue') return point.passengers * point.avgFare;
  return point[metric] ?? modeled[metric] ?? 0;
}

function renderTrend() {
  const svg = document.getElementById('routeTrend');
  const points = (state.selected?.monthly || []).slice().sort((a, b) => a.month.localeCompare(b.month));
  const labels = {
    passengers: ['Passengers', 'Observed passengers', AY.format.integer],
    revenue: ['Estimated market value', 'Average fare × observed passengers', AY.format.compactMoney],
    avgFare: ['Average fare', 'Passenger-weighted average ticket price', AY.format.money],
    saverFare: ['Saver fare', 'Modeled fare input', AY.format.money],
    mainFare: ['Main fare', 'Modeled fare input', AY.format.money],
    flexFare: ['Flex fare', 'Modeled fare input', AY.format.money],
    saverDemand: ['Saver demand', 'Modeled demand input', AY.format.integer],
    mainDemand: ['Main demand', 'Modeled demand input', AY.format.integer],
    flexDemand: ['Flex demand', 'Modeled demand input', AY.format.integer],
  };
  const [title, subtitle, formatter] = labels[state.trendMetric];
  document.getElementById('trendTitle').textContent = `${title} by month`;
  document.getElementById('trendSubtitle').textContent = subtitle;
  document.getElementById('trendUnit').textContent = title;
  if (!points.length) {
    svg.innerHTML = '<text class="trend-empty" x="450" y="165" text-anchor="middle">Monthly data is not available for this route.</text>';
    return;
  }
  const values = points.map(point => trendValue(point, state.trendMetric));
  const W = 900, H = 330, L = 72, R = 28, T = 28, B = 62;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const x = i => L + (points.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (points.length - 1));
  const y = value => H - B - (value - min) / Math.max(max - min, 1) * (H - T - B);
  let html = '';
  for (let i = 0; i <= 4; i++) {
    const value = max - i * (max - min) / 4;
    const yy = y(value);
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="8" y="${yy + 4}">${formatter.format(value)}</text>`;
  }
  points.forEach((point, i) => {
    html += `<text class="scatter-label" x="${x(i)}" y="${H - 26}" text-anchor="middle">${formatMonth(point.month)}</text>`;
  });
  html += `<line class="scatter-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line><line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;
  html += `<polyline class="trend-line" points="${values.map((value, i) => `${x(i)},${y(value)}`).join(' ')}"></polyline>`;
  points.forEach((point, i) => {
    const value = values[i];
    html += `<circle class="trend-point" cx="${x(i)}" cy="${y(value)}" r="5"><title>${formatMonth(point.month)} · ${formatter.format(value)}</title></circle>`;
  });
  svg.innerHTML = html;
}

function selectRoute(key, updateUrl = true) {
  const m = state.markets.find(route => AY.routeKey(route) === key) || state.markets[0];
  state.selected = m;
  state.viewMarkets = state.markets.map(viewMarket).filter(route => route.passengers > 0);
  state.summary = AY.networkSummary(state.viewMarkets);
  const current = viewMarket(m);
  document.getElementById('routeSelect').value = AY.routeKey(m);
  if (updateUrl) history.replaceState(null, '', `route.html?route=${encodeURIComponent(AY.routeKey(m))}`);
  renderSnapshot(current);
  renderBenchmarks(current);
  renderReadout(current);
  renderScatter(current);
  renderPeers(current);
  renderModeledScenario(current);
  renderTrend();
}

async function init() {
  const loaded = await AY.loadMarkets();
  state.markets = loaded.markets;
  state.viewMarkets = state.markets;
  state.source = loaded.source;
  state.isDemo = loaded.isDemo;
  state.summary = AY.networkSummary(state.markets);
  const select = document.getElementById('routeSelect');
  select.innerHTML = state.markets.slice().sort((a, b) => a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination)).map(m => `<option value="${AY.routeKey(m)}">${m.origin} → ${m.destination}</option>`).join('');
  select.addEventListener('change', event => selectRoute(event.target.value));

  const monthSelect = document.getElementById('monthSelect');
  const months = availableMonths();
  monthSelect.innerHTML = `<option value="all">All observed months</option>${months.map(month => `<option value="${month}">${formatMonth(month)}</option>`).join('')}`;
  monthSelect.disabled = months.length === 0;
  monthSelect.addEventListener('change', event => {
    state.selectedMonth = event.target.value;
    selectRoute(AY.routeKey(state.selected), false);
  });
  document.getElementById('trendMetric').addEventListener('change', event => {
    state.trendMetric = event.target.value;
    renderTrend();
  });

  const badge = document.getElementById('routeSourceBadge');
  badge.classList.toggle('ready', !state.isDemo);
  badge.innerHTML = `<i></i> ${state.source}${state.summary.monthsObserved ? ` · up to ${state.summary.monthsObserved} months` : ''}`;

  const initial = findInitialRoute(state.markets);
  selectRoute(AY.routeKey(initial), false);
}

init().catch(error => {
  console.error(error);
  const badge = document.getElementById('routeSourceBadge');
  badge.classList.remove('ready');
  badge.innerHTML = '<i></i> Could not load market data';
});
