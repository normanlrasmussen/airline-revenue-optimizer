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

function rankLabel(rank, total) { return rank ? `#${rank} of ${total}` : '—'; }
function topPercentLabel(percentile) { return `Top ${Math.max(1, Math.round((1 - percentile) * 100))}%`; }
function formatYield(value) { return AY.format.yieldPerMile(value); }

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
  if (!point) return { ...m, passengers: 0, avgFare: 0, revenueProxy: 0, carriers: 0, records: 0, yieldPerMile: null, ...modeledValues({ ...m, passengers: 0, avgFare: 0 }) };
  const avgDistance = point.avgDistance || m.avgDistance;
  const current = {
    ...m,
    ...point,
    avgDistance,
    distanceCoverage: Number.isFinite(point.distanceCoverage) ? point.distanceCoverage : m.distanceCoverage,
    yieldPerMile: Number.isFinite(point.yieldPerMile)
      ? point.yieldPerMile
      : avgDistance && avgDistance > 0 ? point.avgFare / avgDistance : null,
    revenueProxy: point.passengers * point.avgFare,
  };
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
  const valueRank = AY.rankBy(state.viewMarkets, route => route.revenueProxy, m);
  document.title = `${m.origin} → ${m.destination} Route Detail | AeroYield`;
  document.getElementById('routeHeroTitle').textContent = `${m.origin} → ${m.destination}: route detail.`;
  document.getElementById('routeSectionTitle').textContent = `${m.origin} → ${m.destination} · ${state.selectedMonth === 'all' ? 'all observed months' : formatMonth(state.selectedMonth)}`;
  document.getElementById('routePassengers').textContent = AY.format.integer.format(m.passengers);
  document.getElementById('routePassengerRank').textContent = `${rankLabel(volumeRank, state.viewMarkets.length)} by observed passengers`;
  document.getElementById('routeFare').textContent = AY.format.money.format(m.avgFare);
  document.getElementById('routeFareDelta').textContent = `${AY.signedPercent(fareDelta)} vs ${AY.format.money.format(s.weightedFare)} network average`;
  document.getElementById('routeYield').textContent = formatYield(m.yieldPerMile);
  document.getElementById('routeYieldNote').textContent = Number.isFinite(m.yieldPerMile)
    ? `${AY.format.integer.format(m.avgDistance)} passenger-weighted route miles · ${AY.format.percent.format(m.distanceCoverage || 0)} distance coverage`
    : 'distance is not available in the committed summary';
  document.getElementById('routeRevenue').textContent = AY.format.compactMoney.format(m.revenueProxy);
  document.getElementById('routeRevenueRank').textContent = `${rankLabel(valueRank, state.viewMarkets.length)} by average-fare × passenger value`;
  document.getElementById('modeledRouteName').textContent = `${m.origin} → ${m.destination}`;
}

function renderDecisionContext(m) {
  const score = AY.opportunityScore(state.viewMarkets, m);
  document.getElementById('opportunityScore').textContent = `${score}/100`;
  document.getElementById('opportunityText').textContent = score >= 75
    ? 'High-priority screen: this route is commercially material and worth policy testing.'
    : score >= 50 ? 'Moderate-priority screen: worth testing after larger or more variable markets.' : 'Lower-priority screen: smaller expected portfolio impact.';

  const topCarrier = m.topCarriers?.[0];
  document.getElementById('topCarrierShare').textContent = topCarrier ? `${topCarrier.carrier} · ${AY.format.percent.format(topCarrier.share)}` : 'Not available';
  document.getElementById('topCarrierText').textContent = topCarrier
    ? `Largest observed reporting-carrier share among records with carrier detail. Carrier-data coverage: ${AY.format.percent.format(m.carrierCoverage || 0)}.`
    : 'Run the carrier-share enrichment stage to populate this measure.';

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
    document.getElementById('reverseDetail').textContent = `Average fare is ${AY.signedPercent(fareDiff)} and observed passengers are ${AY.signedPercent(paxDiff)} versus the reverse direction.`;
  } else {
    document.getElementById('reverseDetail').textContent = 'The reverse direction is not present in the current route summary.';
  }
}

function renderReadout(m) {
  const s = state.summary;
  const volumePct = AY.percentileRank(state.viewMarkets.map(route => route.passengers), m.passengers);
  const valuePct = AY.percentileRank(state.viewMarkets.map(route => route.revenueProxy), m.revenueProxy);
  const fareDelta = s.weightedFare ? m.avgFare / s.weightedFare - 1 : 0;
  const score = AY.opportunityScore(state.viewMarkets, m);
  const items = [
    {
      label: 'Passenger scale',
      value: `${Math.round(volumePct * 100)}th percentile`,
      text: `${topPercentLabel(volumePct)} by passenger volume. ${volumePct >= 0.75 ? 'Even small per-passenger improvements can matter at this scale.' : 'The market is smaller, so portfolio impact is likely lower.'}`,
    },
    {
      label: 'Average fare',
      value: `${AY.signedPercent(fareDelta)} vs network`,
      text: `${Math.abs(fareDelta) < 0.05 ? 'Average fare is close to the network average.' : fareDelta > 0 ? 'Average fare is above the network average.' : 'Average fare is below the network average.'} ${Number.isFinite(m.yieldPerMile) ? `Yield is ${formatYield(m.yieldPerMile)}.` : 'Distance enrichment is needed before comparing yield.'}`,
    },
    {
      label: 'Estimated market value',
      value: `${Math.round(valuePct * 100)}th percentile`,
      text: valuePct >= 0.8 ? 'Traffic and ticket price combine to make this a high-materiality route.' : 'Total fare × passenger value is less concentrated here than in the largest routes.',
    },
    {
      label: 'Opportunity score',
      value: `${score}/100`,
      text: 'This screening score prioritizes where analysis is most worthwhile; it is not a predicted revenue lift.',
    },
  ];
  if (m.topCarriers?.length) {
    items.push({ label: 'Competition', value: `${m.topCarriers[0].carrier} ${AY.format.percent.format(m.topCarriers[0].share)}`, text: `${m.topCarriers.length} carrier shares are available in the enriched summary. Use shares rather than carrier count when evaluating concentration.` });
  }
  document.getElementById('analystReadout').innerHTML = items.map(item => `<div class="readout-item"><div><span>${item.label}</span><strong>${item.value}</strong></div><p>${item.text}</p></div>`).join('');
  document.getElementById('routePriority').textContent = score >= 75 ? 'High-priority test market' : score >= 50 ? 'Worth testing' : 'Monitor';
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
  html += `<line class="scatter-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line><line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;
  html += `<line class="benchmark-line" x1="${x(safeNumber(state.summary.weightedFare))}" y1="${T}" x2="${x(safeNumber(state.summary.weightedFare))}" y2="${H - B}"></line>`;
  html += `<line class="benchmark-line" x1="${L}" y1="${y(safeNumber(state.summary.medianPassengers))}" x2="${W - R}" y2="${y(safeNumber(state.summary.medianPassengers))}"></line>`;
  markets.forEach(route => {
    const selected = AY.routeKey(route) === AY.routeKey(m);
    html += `<circle class="scatter-point ${selected ? 'active selected-route-point' : 'network-context-point'}" cx="${x(route.avgFare)}" cy="${y(route.passengers)}" r="${selected ? 10 : 4}"><title>${route.origin} → ${route.destination} · ${AY.format.money.format(route.avgFare)} · ${AY.format.integer.format(route.passengers)} passengers</title></circle>`;
  });
  html += `<text class="selected-route-label" x="${Math.min(x(m.avgFare) + 13, W - 110)}" y="${Math.max(y(m.passengers) - 13, T + 15)}">${m.origin} → ${m.destination}</text>`;
  svg.innerHTML = html;
}

function safeNumber(value) { return Number.isFinite(value) ? value : 0; }

function renderPeers(m) {
  const peers = state.viewMarkets.filter(route => route.origin === m.origin && AY.routeKey(route) !== AY.routeKey(m)).sort((a, b) => b.revenueProxy - a.revenueProxy).slice(0, 8);
  document.getElementById('peerHeading').textContent = `${m.origin} peers`;
  document.getElementById('peerTableBody').innerHTML = peers.map(route => `<tr>
    <td><a class="route-name-link" href="${AY.routeHref(route)}"><strong>${route.origin} → ${route.destination}</strong></a></td>
    <td>${AY.format.integer.format(route.passengers)}</td>
    <td>${AY.format.money.format(route.avgFare)}</td>
    <td>${formatYield(route.yieldPerMile)}</td>
    <td>${AY.format.compactMoney.format(route.revenueProxy)}</td>
    <td><a class="table-action" href="${AY.routeHref(route)}">Open →</a></td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty-table">No other routes from this origin are present in the current summary.</td></tr>';
}

function renderCarrierShares(m) {
  const rows = m.topCarriers || [];
  document.getElementById('carrierShareSubtitle').textContent = `${m.origin} → ${m.destination}`;
  const container = document.getElementById('carrierShareBars');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-table">Carrier-share detail is not available. Run the enrichment stage after processing DB1C data.</div>';
    return;
  }
  const max = Math.max(...rows.map(row => row.share), 0.01);
  container.innerHTML = rows.map(row => `<div class="bar-row"><span class="bar-label">${row.carrier}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${100 * row.share / max}%"></span></span><span class="bar-value">${AY.format.percent.format(row.share)}</span></div>`).join('');
}

function renderModeledScenario(m) {
  const fareRows = [{ name: 'Saver', value: Number(m.saverFare) || 0 }, { name: 'Main', value: Number(m.mainFare) || 0 }, { name: 'Flex', value: Number(m.flexFare) || 0 }];
  const demandRows = [{ name: 'Saver', value: Number(m.saverDemand) || 0 }, { name: 'Main', value: Number(m.mainDemand) || 0 }, { name: 'Flex', value: Number(m.flexDemand) || 0 }];
  const maxFare = Math.max(...fareRows.map(row => row.value), 1);
  const maxDemand = Math.max(...demandRows.map(row => row.value), 1);
  document.getElementById('modeledFareBars').innerHTML = fareRows.map(row => `<div class="bar-row"><span class="bar-label">${row.name}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${100 * row.value / maxFare}%"></span></span><span class="bar-value">${AY.format.money.format(row.value)}</span></div>`).join('');
  document.getElementById('modeledDemandBars').innerHTML = demandRows.map(row => `<div class="bar-row"><span class="bar-label">${row.name}</span><span class="bar-track"><span class="bar-fill modeled-demand-fill" style="display:block;width:${100 * row.value / maxDemand}%"></span></span><span class="bar-value">${AY.format.integer.format(row.value)}</span></div>`).join('');
}

function trendValue(point, metric) {
  const modeled = modeledValues(point);
  if (metric === 'revenue') return point.passengers * point.avgFare;
  if (metric === 'yield') {
    if (Number.isFinite(point.yieldPerMile)) return point.yieldPerMile;
    const distance = point.avgDistance || state.selected?.avgDistance;
    return distance && distance > 0 ? point.avgFare / distance : NaN;
  }
  return point[metric] ?? modeled[metric] ?? 0;
}

function renderTrend() {
  const svg = document.getElementById('routeTrend');
  const points = (state.selected?.monthly || []).slice().sort((a, b) => a.month.localeCompare(b.month));
  const labels = {
    passengers: ['Passengers', 'Observed passengers', value => AY.format.integer.format(value)],
    revenue: ['Estimated market value', 'Average fare × observed passengers', value => AY.format.compactMoney.format(value)],
    avgFare: ['Average fare', 'Passenger-weighted average ticket price', value => AY.format.money.format(value)],
    yield: ['Yield per mile', 'Passenger-weighted fare revenue per passenger-mile', value => formatYield(value)],
    saverFare: ['Saver fare', 'Modeled fare input', value => AY.format.money.format(value)],
    mainFare: ['Main fare', 'Modeled fare input', value => AY.format.money.format(value)],
    flexFare: ['Flex fare', 'Modeled fare input', value => AY.format.money.format(value)],
    saverDemand: ['Saver demand', 'Modeled demand input', value => AY.format.integer.format(value)],
    mainDemand: ['Main demand', 'Modeled demand input', value => AY.format.integer.format(value)],
    flexDemand: ['Flex demand', 'Modeled demand input', value => AY.format.integer.format(value)],
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
  if (!values.some(Number.isFinite)) {
    svg.innerHTML = '<text class="trend-empty" x="450" y="165" text-anchor="middle">This measure is not available until distance enrichment is run.</text>';
    return;
  }
  const finite = values.filter(Number.isFinite);
  const W = 900, H = 330, L = 82, R = 28, T = 28, B = 62;
  const max = Math.max(...finite, 1);
  const min = Math.min(...finite, 0);
  const x = i => L + (points.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (points.length - 1));
  const y = value => H - B - (value - min) / Math.max(max - min, 1) * (H - T - B);
  let html = '';
  for (let i = 0; i <= 4; i++) {
    const value = max - i * (max - min) / 4;
    const yy = y(value);
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="8" y="${yy + 4}">${formatter(value)}</text>`;
  }
  points.forEach((point, i) => html += `<text class="scatter-label" x="${x(i)}" y="${H - 26}" text-anchor="middle">${formatMonth(point.month)}</text>`);
  html += `<line class="scatter-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line><line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;
  const validPoints = values.map((value, i) => Number.isFinite(value) ? `${x(i)},${y(value)}` : null).filter(Boolean);
  if (validPoints.length > 1) html += `<polyline class="trend-line" points="${validPoints.join(' ')}"></polyline>`;
  points.forEach((point, i) => {
    const value = values[i];
    if (Number.isFinite(value)) html += `<circle class="trend-point" cx="${x(i)}" cy="${y(value)}" r="5"><title>${formatMonth(point.month)} · ${formatter(value)}</title></circle>`;
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
  renderDecisionContext(current);
  renderReadout(current);
  renderScatter(current);
  renderPeers(current);
  renderCarrierShares(current);
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
