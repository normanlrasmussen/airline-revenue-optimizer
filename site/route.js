const AY = window.AeroYieldData;
const state = { markets: [], summary: null, source: '', isDemo: false, selected: null };

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

function renderSnapshot(m) {
  const s = state.summary;
  const fareDelta = s.weightedFare ? m.avgFare / s.weightedFare - 1 : 0;
  const volumeRank = AY.rankBy(state.markets, route => route.passengers, m);
  const revenueRank = AY.rankBy(state.markets, route => route.revenueProxy, m);
  document.title = `${m.origin} → ${m.destination} Route Intelligence | AeroYield`;
  document.getElementById('routeHeroTitle').textContent = `${m.origin} → ${m.destination}: market intelligence.`;
  document.getElementById('routeSectionTitle').textContent = `${m.origin} → ${m.destination} snapshot`;
  document.getElementById('routeFare').textContent = AY.format.money.format(m.avgFare);
  document.getElementById('routeFareDelta').textContent = `${AY.signedPercent(fareDelta)} vs ${AY.format.money.format(s.weightedFare)} network benchmark`;
  document.getElementById('routePassengers').textContent = AY.format.integer.format(m.passengers);
  document.getElementById('routePassengerRank').textContent = `${rankLabel(volumeRank, state.markets.length)} by passenger volume`;
  document.getElementById('routeRevenue').textContent = AY.format.compactMoney.format(m.revenueProxy);
  document.getElementById('routeRevenueRank').textContent = `${rankLabel(revenueRank, state.markets.length)} by fare × passenger proxy`;
  document.getElementById('routeCarriers').textContent = AY.format.integer.format(m.carriers);
  document.getElementById('routeCarrierContext').textContent = `network median ${AY.format.integer.format(s.medianCarriers)} carriers`;
  document.getElementById('modeledRouteName').textContent = `${m.origin} → ${m.destination}`;
}

function renderBenchmarks(m) {
  const volumePct = AY.percentileRank(state.markets.map(route => route.passengers), m.passengers);
  const farePct = AY.percentileRank(state.markets.map(route => route.avgFare), m.avgFare);
  document.getElementById('volumePercentile').textContent = `${Math.round(volumePct * 100)}th`;
  document.getElementById('volumePercentileText').textContent = `${topPercentLabel(volumePct)} by observed passenger volume in the committed extract.`;
  document.getElementById('farePercentile').textContent = `${Math.round(farePct * 100)}th`;

  const originMarkets = state.markets.filter(route => route.origin === m.origin);
  const originPassengers = originMarkets.reduce((sum, route) => sum + route.passengers, 0);
  const share = originPassengers ? m.passengers / originPassengers : 0;
  document.getElementById('originShare').textContent = AY.format.percent.format(share);
  document.getElementById('originShareText').textContent = `${AY.format.integer.format(m.passengers)} of ${AY.format.integer.format(originPassengers)} observed passengers among ${originMarkets.length} routes from ${m.origin}.`;

  const reverse = state.markets.find(route => route.origin === m.destination && route.destination === m.origin);
  document.getElementById('reverseRoute').textContent = reverse ? `${reverse.origin} → ${reverse.destination}` : 'Not in extract';
  if (reverse) {
    const fareDiff = reverse.avgFare ? m.avgFare / reverse.avgFare - 1 : 0;
    const paxDiff = reverse.passengers ? m.passengers / reverse.passengers - 1 : 0;
    document.getElementById('reverseDetail').textContent = `This direction is ${AY.signedPercent(fareDiff)} on average fare and ${AY.signedPercent(paxDiff)} on observed passengers versus the reverse market.`;
  } else {
    document.getElementById('reverseDetail').textContent = 'The reverse directional market is not present in the committed top-route extract.';
  }
}

function renderReadout(m) {
  const s = state.summary;
  const volumePct = AY.percentileRank(state.markets.map(route => route.passengers), m.passengers);
  const revenuePct = AY.percentileRank(state.markets.map(route => route.revenueProxy), m.revenueProxy);
  const fareDelta = s.weightedFare ? m.avgFare / s.weightedFare - 1 : 0;
  const reverse = state.markets.find(route => route.origin === m.destination && route.destination === m.origin);
  const items = [];

  items.push({
    label: 'Scale',
    value: `${Math.round(volumePct * 100)}th percentile`,
    text: `${topPercentLabel(volumePct)} by passenger volume. ${volumePct >= 0.75 ? 'Large enough that small revenue-management improvements can matter materially.' : 'This is not one of the network’s largest traffic pools, so prioritize only if economics or strategic value justify it.'}`,
  });

  items.push({
    label: 'Fare level',
    value: `${AY.signedPercent(fareDelta)} vs network`,
    text: `${Math.abs(fareDelta) < 0.05 ? 'Raw fare is close to the network benchmark.' : fareDelta > 0 ? 'Raw fare is above the network benchmark.' : 'Raw fare is below the network benchmark.'} Treat this as a pricing signal, not yield, because route distance is not yet in the site summary.`,
  });

  items.push({
    label: 'Revenue exposure',
    value: `${Math.round(revenuePct * 100)}th percentile`,
    text: `${revenuePct >= 0.8 ? 'This route is a high-priority candidate for protection-level, booking-limit, or bid-price experiments.' : 'The route has less network-wide revenue exposure, so expected lift should be weighed against implementation effort.'}`,
  });

  items.push({
    label: 'Competition breadth',
    value: `${m.carriers} carriers`,
    text: `${m.carriers > s.medianCarriers ? 'More reporting carriers than the network median may indicate a broader competitive set.' : m.carriers < s.medianCarriers ? 'Fewer reporting carriers than the network median may mean a narrower competitive set.' : 'Carrier count is near the network median.'} Carrier count alone is not market share or concentration.`,
  });

  if (reverse) {
    const fareDiff = reverse.avgFare ? Math.abs(m.avgFare / reverse.avgFare - 1) : 0;
    const paxDiff = reverse.passengers ? Math.abs(m.passengers / reverse.passengers - 1) : 0;
    items.push({
      label: 'Directionality',
      value: `${AY.format.money.format(reverse.avgFare)} reverse fare`,
      text: `${fareDiff > 0.08 || paxDiff > 0.08 ? 'The two directions are meaningfully asymmetric; investigate directional demand mix before using one control policy for both.' : 'The reverse market is broadly similar on fare and traffic, so a symmetric starting assumption is more defensible.'}`,
    });
  }

  document.getElementById('analystReadout').innerHTML = items.map(item => `
    <div class="readout-item"><div><span>${item.label}</span><strong>${item.value}</strong></div><p>${item.text}</p></div>`).join('');

  let priority = 'Monitor';
  if (volumePct >= 0.75 && revenuePct >= 0.75) priority = 'High-priority RM market';
  else if (revenuePct >= 0.6) priority = 'Worth scenario testing';
  document.getElementById('routePriority').textContent = priority;
}

function renderScatter(m) {
  const svg = document.getElementById('routeScatter');
  const markets = state.markets;
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
    html += `<circle class="scatter-point ${selected ? 'active selected-route-point' : 'network-context-point'}" cx="${x(route.avgFare)}" cy="${y(route.passengers)}" r="${selected ? 10 : 4}"><title>${route.origin} → ${route.destination} · ${AY.format.money.format(route.avgFare)} · ${AY.format.integer.format(route.passengers)} passengers</title></circle>`;
  });
  html += `<text class="selected-route-label" x="${Math.min(x(m.avgFare) + 13, W - 110)}" y="${Math.max(y(m.passengers) - 13, T + 15)}">${m.origin} → ${m.destination}</text>`;
  svg.innerHTML = html;
}

function renderPeers(m) {
  const peers = state.markets.filter(route => route.origin === m.origin && AY.routeKey(route) !== AY.routeKey(m)).sort((a, b) => b.revenueProxy - a.revenueProxy).slice(0, 8);
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
      <td>${AY.format.compactMoney.format(route.revenueProxy)}</td>
      <td><a class="table-action" href="${AY.routeHref(route)}">Analyze →</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty-table">No other routes from this origin are present in the committed extract.</td></tr>';
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

function selectRoute(key, updateUrl = true) {
  const m = state.markets.find(route => AY.routeKey(route) === key) || state.markets[0];
  state.selected = m;
  document.getElementById('routeSelect').value = AY.routeKey(m);
  if (updateUrl) history.replaceState(null, '', `route.html?route=${encodeURIComponent(AY.routeKey(m))}`);
  renderSnapshot(m);
  renderBenchmarks(m);
  renderReadout(m);
  renderScatter(m);
  renderPeers(m);
  renderModeledScenario(m);
}

async function init() {
  const loaded = await AY.loadMarkets();
  state.markets = loaded.markets;
  state.source = loaded.source;
  state.isDemo = loaded.isDemo;
  state.summary = AY.networkSummary(state.markets);
  const select = document.getElementById('routeSelect');
  select.innerHTML = state.markets.slice().sort((a, b) => a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination)).map(m => `<option value="${AY.routeKey(m)}">${m.origin} → ${m.destination}</option>`).join('');
  select.addEventListener('change', event => selectRoute(event.target.value));

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
