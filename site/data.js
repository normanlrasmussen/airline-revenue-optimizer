const AY = window.AeroYieldData;
const state = { markets: [], summary: null, source: '', isDemo: false, filter: '', sort: 'revenue' };

function metricValue(m, sort) {
  if (sort === 'passengers') return m.passengers;
  if (sort === 'fare') return m.avgFare;
  if (sort === 'carriers') return m.carriers;
  return m.revenueProxy;
}

function renderSnapshot() {
  const s = state.summary;
  document.getElementById('routeCount').textContent = AY.format.integer.format(s.routeCount);
  document.getElementById('totalPassengers').textContent = AY.format.integer.format(s.totalPassengers);
  document.getElementById('weightedFare').textContent = AY.format.money.format(s.weightedFare);
  document.getElementById('revenueProxy').textContent = AY.format.compactMoney.format(s.totalRevenueProxy);
  const badge = document.getElementById('sourceBadge');
  badge.classList.toggle('ready', !state.isDemo);
  badge.innerHTML = `<i></i> ${state.source}${s.monthsObserved ? ` · up to ${s.monthsObserved} months` : ''}`;

  document.getElementById('top10Share').textContent = AY.format.percent.format(s.top10PassengerShare);
  document.getElementById('fareIqr').textContent = `${AY.format.money.format(s.fareQ1)}–${AY.format.money.format(s.fareQ3)}`;
  document.getElementById('largestRoute').textContent = s.topVolume ? `${s.topVolume.origin} → ${s.topVolume.destination}` : '—';
  document.getElementById('largestRouteDetail').textContent = s.topVolume ? `${AY.format.integer.format(s.topVolume.passengers)} observed passengers; ${AY.format.money.format(s.topVolume.avgFare)} average fare.` : '';
  document.getElementById('largestRevenueRoute').textContent = s.topRevenue ? `${s.topRevenue.origin} → ${s.topRevenue.destination}` : '—';
  document.getElementById('largestRevenueDetail').textContent = s.topRevenue ? `${AY.format.compactMoney.format(s.topRevenue.revenueProxy)} fare × passenger proxy.` : '';
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
  const minY = 0;
  const maxY = Math.max(...pax) * 1.08;
  const x = value => L + (value - minX) / Math.max(maxX - minX, 1) * (W - L - R);
  const y = value => H - B - (value - minY) / Math.max(maxY - minY, 1) * (H - T - B);
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
  html += `<text class="benchmark-label" x="${Math.min(benchmarkX + 6, W - 150)}" y="${T + 14}">weighted fare ${AY.format.money.format(state.summary.weightedFare)}</text>`;
  html += `<text class="benchmark-label" x="${L + 6}" y="${Math.max(benchmarkY - 7, T + 14)}">median volume</text>`;

  const labelRoutes = new Set(markets.slice().sort((a, b) => b.revenueProxy - a.revenueProxy).slice(0, 8).map(AY.routeKey));
  markets.forEach(m => {
    const href = AY.routeHref(m);
    html += `<a href="${href}" aria-label="Open ${m.origin} to ${m.destination}: ${AY.format.money.format(m.avgFare)} average fare, ${AY.format.integer.format(m.passengers)} passengers"><circle class="scatter-point" cx="${x(m.avgFare)}" cy="${y(m.passengers)}" r="6"><title>${m.origin} → ${m.destination} · ${AY.format.money.format(m.avgFare)} · ${AY.format.integer.format(m.passengers)} passengers</title></circle></a>`;
    if (labelRoutes.has(AY.routeKey(m))) html += `<text class="scatter-label point-label" x="${x(m.avgFare) + 8}" y="${y(m.passengers) - 8}">${m.origin}–${m.destination}</text>`;
  });

  svg.innerHTML = html;
}

function renderTable() {
  const needle = state.filter.trim().toUpperCase();
  const filtered = state.markets.filter(m => !needle || `${m.origin} ${m.destination} ${AY.routeKey(m)} ${m.route || ''}`.toUpperCase().includes(needle));
  filtered.sort((a, b) => metricValue(b, state.sort) - metricValue(a, state.sort));
  const body = document.getElementById('routeTableBody');
  body.innerHTML = filtered.map((m, index) => {
    const fareDelta = state.summary.weightedFare ? m.avgFare / state.summary.weightedFare - 1 : 0;
    const deltaClass = fareDelta > 0.02 ? 'metric-up' : fareDelta < -0.02 ? 'metric-down' : 'metric-flat';
    return `<tr>
      <td class="rank-cell">${index + 1}</td>
      <td><a class="route-name-link" href="${AY.routeHref(m)}"><strong>${m.origin} → ${m.destination}</strong><span>${m.monthsObserved ? `${m.monthsObserved} months observed` : 'coverage not reported'}</span></a></td>
      <td>${AY.format.integer.format(m.passengers)}</td>
      <td>${AY.format.money.format(m.avgFare)}</td>
      <td><span class="metric-pill ${deltaClass}">${AY.signedPercent(fareDelta)}</span></td>
      <td>${AY.format.integer.format(m.carriers)}</td>
      <td>${AY.format.compactMoney.format(m.revenueProxy)}</td>
      <td><a class="table-action" href="${AY.routeHref(m)}">Analyze →</a></td>
    </tr>`;
  }).join('');
  document.getElementById('routeTableNote').textContent = `${AY.format.integer.format(filtered.length)} of ${AY.format.integer.format(state.markets.length)} routes shown · ranking is within the committed site extract.`;
}

async function init() {
  const loaded = await AY.loadMarkets();
  state.markets = loaded.markets;
  state.source = loaded.source;
  state.isDemo = loaded.isDemo;
  state.summary = AY.networkSummary(state.markets);

  renderSnapshot();
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
