const AY = window.AeroYieldData;
const state = { markets: [], summary: null, source: '', isDemo: false, filter: '', sort: 'opportunity' };

function metricValue(m, sort) {
  if (sort === 'passengers') return m.passengers;
  if (sort === 'fare') return m.avgFare;
  if (sort === 'yield') return m.yieldPerMile ?? -1;
  if (sort === 'carriers') return m.carriers;
  if (sort === 'opportunity') return AY.opportunityScore(state.markets, m);
  return m.revenueProxy;
}

function formatYield(value) {
  return AY.format.yieldPerMile(value);
}

function formatMonth(period) {
  const [year, month] = String(period).split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function renderSnapshot() {
  const s = state.summary;
  document.getElementById('routeCount').textContent = AY.format.integer.format(s.routeCount);
  document.getElementById('totalPassengers').textContent = AY.format.integer.format(s.totalPassengers);
  document.getElementById('weightedFare').textContent = AY.format.money.format(s.weightedFare);
  document.getElementById('networkYield').textContent = formatYield(s.networkYield);
  document.getElementById('networkYieldNote').textContent = Number.isFinite(s.networkYield)
    ? `${AY.format.integer.format(s.weightedDistance)} passenger-weighted average miles`
    : 'distance is not present in the committed summary; run the enrichment step';

  const badge = document.getElementById('sourceBadge');
  badge.classList.toggle('ready', !state.isDemo);
  badge.innerHTML = `<i></i> ${state.source}${s.monthsObserved ? ` · up to ${s.monthsObserved} months` : ''}`;

  document.getElementById('top10Share').textContent = AY.format.percent.format(s.top10PassengerShare);
  document.getElementById('largestRoute').textContent = s.topVolume ? `${s.topVolume.origin} → ${s.topVolume.destination}` : '—';
  document.getElementById('largestRouteDetail').textContent = s.topVolume ? `${AY.format.integer.format(s.topVolume.passengers)} observed passengers at an average fare of ${AY.format.money.format(s.topVolume.avgFare)}.` : '';
  document.getElementById('largestRevenueRoute').textContent = s.topRevenue ? `${s.topRevenue.origin} → ${s.topRevenue.destination}` : '—';
  document.getElementById('largestRevenueDetail').textContent = s.topRevenue ? `${AY.format.compactMoney.format(s.topRevenue.revenueProxy)} average-fare × passenger value.` : '';
  document.getElementById('topOpportunityRoute').textContent = s.topOpportunity ? `${s.topOpportunity.origin} → ${s.topOpportunity.destination}` : '—';
  document.getElementById('topOpportunityDetail').textContent = s.topOpportunity ? `Score ${AY.opportunityScore(state.markets, s.topOpportunity)}/100. High score means commercially material and worth deeper analysis; it is not a predicted revenue lift.` : '';
}

function renderRevenueBars() {
  const rows = state.markets.slice().sort((a, b) => b.revenueProxy - a.revenueProxy).slice(0, 10);
  const max = Math.max(...rows.map(m => m.revenueProxy), 1);
  document.getElementById('revenueBars').innerHTML = rows.map(m => `
    <a class="bar-row route-bar-link" href="${AY.routeHref(m)}">
      <span class="bar-label">${m.origin}–${m.destination}</span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${100 * m.revenueProxy / max}%"></span></span>
      <span class="bar-value">${AY.format.compactMoney.format(m.revenueProxy)}</span>
    </a>`).join('');
}

function renderScatter() {
  const svg = document.getElementById('networkScatter');
  const markets = state.markets;
  const W = 760, H = 360, L = 68, R = 28, T = 26, B = 52;
  const fares = markets.map(m => m.avgFare);
  const pax = markets.map(m => m.passengers);
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
  }
  for (let i = 0; i <= 4; i++) {
    const value = minX + i * (maxX - minX) / 4;
    html += `<text class="scatter-label" x="${x(value)}" y="${H - 16}" text-anchor="middle">$${Math.round(value)}</text>`;
  }
  html += `<line class="scatter-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line>`;
  html += `<line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;

  const benchmarkX = x(state.summary.weightedFare);
  const benchmarkY = y(state.summary.medianPassengers);
  html += `<line class="benchmark-line" x1="${benchmarkX}" y1="${T}" x2="${benchmarkX}" y2="${H - B}"></line>`;
  html += `<line class="benchmark-line" x1="${L}" y1="${benchmarkY}" x2="${W - R}" y2="${benchmarkY}"></line>`;
  html += `<text class="benchmark-label" x="${Math.min(benchmarkX + 6, W - 150)}" y="${T + 14}">avg ticket ${AY.format.money.format(state.summary.weightedFare)}</text>`;
  html += `<text class="benchmark-label" x="${L + 6}" y="${Math.max(benchmarkY - 7, T + 14)}">median passengers</text>`;

  const labelRoutes = new Set(markets.slice().sort((a, b) => b.revenueProxy - a.revenueProxy).slice(0, 8).map(AY.routeKey));
  markets.forEach(m => {
    html += `<a href="${AY.routeHref(m)}" aria-label="Open ${m.origin} to ${m.destination}: ${AY.format.money.format(m.avgFare)} average fare, ${AY.format.integer.format(m.passengers)} passengers"><circle class="scatter-point" cx="${x(m.avgFare)}" cy="${y(m.passengers)}" r="6"><title>${m.origin} → ${m.destination} · ${AY.format.money.format(m.avgFare)} average fare · ${AY.format.integer.format(m.passengers)} passengers</title></circle></a>`;
    if (labelRoutes.has(AY.routeKey(m))) html += `<text class="scatter-label point-label" x="${x(m.avgFare) + 8}" y="${y(m.passengers) - 8}">${m.origin}–${m.destination}</text>`;
  });
  svg.innerHTML = html;
}

function renderTrend(svgId, rows, valueFn, formatter) {
  const svg = document.getElementById(svgId);
  if (!rows.length) {
    svg.innerHTML = '<text class="trend-empty" x="450" y="165" text-anchor="middle">Monthly data is not available.</text>';
    return;
  }
  const values = rows.map(valueFn);
  const W = 900, H = 330, L = 78, R = 28, T = 28, B = 62;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const x = i => L + (rows.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (rows.length - 1));
  const y = value => H - B - (value - min) / Math.max(max - min, 1) * (H - T - B);
  let html = '';
  for (let i = 0; i <= 4; i++) {
    const value = max - i * (max - min) / 4;
    const yy = y(value);
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="8" y="${yy + 4}">${formatter(value)}</text>`;
  }
  rows.forEach((row, i) => {
    html += `<text class="scatter-label" x="${x(i)}" y="${H - 26}" text-anchor="middle">${formatMonth(row.month)}</text>`;
  });
  html += `<line class="scatter-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"></line><line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"></line>`;
  html += `<polyline class="trend-line" points="${values.map((value, i) => `${x(i)},${y(value)}`).join(' ')}"></polyline>`;
  rows.forEach((row, i) => html += `<circle class="trend-point" cx="${x(i)}" cy="${y(values[i])}" r="5"><title>${formatMonth(row.month)} · ${formatter(values[i])}</title></circle>`);
  svg.innerHTML = html;
}

function renderNetworkTrends() {
  const monthly = AY.networkMonthly(state.markets);
  renderTrend('networkPassengerTrend', monthly, row => row.passengers, value => AY.format.integer.format(value));
  renderTrend('networkFareTrend', monthly, row => row.avgFare, value => AY.format.money.format(value));
}

function renderTable() {
  const needle = state.filter.trim().toUpperCase();
  const filtered = state.markets.filter(m => !needle || `${m.origin} ${m.destination} ${AY.routeKey(m)} ${m.route || ''}`.toUpperCase().includes(needle));
  filtered.sort((a, b) => metricValue(b, state.sort) - metricValue(a, state.sort));
  const body = document.getElementById('routeTableBody');
  body.innerHTML = filtered.map((m, index) => {
    const topCarrier = m.topCarriers?.[0];
    const opportunity = AY.opportunityScore(state.markets, m);
    return `<tr>
      <td class="rank-cell">${index + 1}</td>
      <td><a class="route-name-link" href="${AY.routeHref(m)}"><strong>${m.origin} → ${m.destination}</strong><span>${m.monthsObserved ? `${m.monthsObserved} months observed` : 'coverage not reported'}</span></a></td>
      <td>${AY.format.integer.format(m.passengers)}</td>
      <td>${AY.format.money.format(m.avgFare)}</td>
      <td>${formatYield(m.yieldPerMile)}</td>
      <td>${topCarrier ? `${topCarrier.carrier} · ${AY.format.percent.format(topCarrier.share)}` : '—'}</td>
      <td title="Average fare × observed passengers">${AY.format.compactMoney.format(m.revenueProxy)}</td>
      <td><span class="metric-pill ${opportunity >= 75 ? 'metric-up' : opportunity >= 50 ? 'metric-flat' : 'metric-down'}">${opportunity}</span></td>
      <td><a class="table-action" href="${AY.routeHref(m)}">Open →</a></td>
    </tr>`;
  }).join('');
  document.getElementById('routeTableNote').textContent = `${AY.format.integer.format(filtered.length)} of ${AY.format.integer.format(state.markets.length)} routes shown. Yield and carrier share appear only when the source extract includes the required fields.`;
}

async function init() {
  const loaded = await AY.loadMarkets();
  state.markets = loaded.markets;
  state.source = loaded.source;
  state.isDemo = loaded.isDemo;
  state.summary = AY.networkSummary(state.markets);

  renderSnapshot();
  renderNetworkTrends();
  renderRevenueBars();
  renderScatter();
  renderTable();

  document.getElementById('routeSearch').addEventListener('input', event => {
    state.filter = event.target.value;
    renderTable();
  });
  document.getElementById('routeSort').addEventListener('change', event => {
    state.sort = event.target.value;
    renderTable();
  });
}

init().catch(error => {
  console.error(error);
  const badge = document.getElementById('sourceBadge');
  badge.classList.remove('ready');
  badge.innerHTML = '<i></i> Could not load market data';
});
