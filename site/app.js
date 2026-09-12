const AY = window.AeroYieldData;
const SIM = window.AeroYieldSimulation;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const state = { markets: [], selected: null, result: null };

function policyLabel(key) {
  return { open: 'Open Sales', emsr: 'EMSR-b', dp: 'Dynamic Programming', clairvoyant: 'Clairvoyant upper bound' }[key] || key;
}

function selectedPolicies() {
  const selected = [...document.querySelectorAll('[data-policy]')].filter(input => input.checked).map(input => input.dataset.policy);
  return selected.includes('open') ? selected : ['open', ...selected];
}

function scaledMarket() {
  const scale = Number(document.getElementById('demandScale').value || 100) / 100;
  return {
    ...state.selected,
    saverDemand: Number(state.selected.saverDemand || 0) * scale,
    mainDemand: Number(state.selected.mainDemand || 0) * scale,
    flexDemand: Number(state.selected.flexDemand || 0) * scale,
  };
}

function liftVsOpen(summary, open) {
  return open.averageRevenue ? summary.averageRevenue / open.averageRevenue - 1 : 0;
}

function bestSelectedPolicy(result) {
  const policies = selectedPolicies();
  return policies.reduce((best, key) => result.summaries[key].averageRevenue > result.summaries[best].averageRevenue ? key : best, policies[0]);
}

function renderDecision(result) {
  const best = bestSelectedPolicy(result);
  const bestSummary = result.summaries[best];
  const open = result.summaries.open;
  const clair = result.summaries.clairvoyant;
  const lift = liftVsOpen(bestSummary, open);
  const regret = clair.averageRevenue - bestSummary.averageRevenue;

  document.getElementById('bestPolicyName').textContent = policyLabel(best);
  document.getElementById('bestPolicyLift').textContent = `${lift >= 0 ? '+' : ''}${percent.format(lift)}`;
  document.getElementById('bestRevenue').textContent = money.format(bestSummary.averageRevenue);
  document.getElementById('clairvoyantGap').textContent = money.format(regret);
  document.getElementById('bestLoad').textContent = percent.format(bestSummary.averageLoadFactor);
  document.getElementById('bestAcceptedFare').textContent = money.format(bestSummary.averageAcceptedFare);
  document.getElementById('bestPolicySummary').textContent = best === 'open'
    ? 'Under these assumptions, protecting capacity did not improve expected revenue over accepting requests until full.'
    : `${policyLabel(best)} earns ${money.format(bestSummary.averageRevenue - open.averageRevenue)} more than Open Sales on average across the same simulated demand streams.`;

  const scale = Number(document.getElementById('demandScale').value || 100);
  document.getElementById('experimentLabel').textContent = `${result.replications.toLocaleString()} runs · ${scale}% demand`;
}

function renderRevenueBars(result) {
  const policies = [...selectedPolicies(), 'clairvoyant'];
  const max = Math.max(...policies.map(key => result.summaries[key].averageRevenue), 1);
  document.getElementById('policyRevenueBars').innerHTML = policies.map(key => {
    const s = result.summaries[key];
    return `<div class="bar-row"><span class="bar-label">${policyLabel(key)}</span><span class="bar-track"><span class="bar-fill ${key === 'clairvoyant' ? 'modeled-demand-fill' : ''}" style="display:block;width:${100 * s.averageRevenue / max}%"></span></span><span class="bar-value">${money.format(s.averageRevenue)}</span></div>`;
  }).join('');
}

function renderPolicyTable(result) {
  const policies = [...selectedPolicies(), 'clairvoyant'];
  const open = result.summaries.open;
  document.getElementById('optimizerPolicyTable').innerHTML = policies.map(key => {
    const s = result.summaries[key];
    const lift = liftVsOpen(s, open);
    return `<tr>
      <td><strong>${policyLabel(key)}</strong></td>
      <td>${money.format(s.averageRevenue)}</td>
      <td>${key === 'open' ? 'Baseline' : `${lift >= 0 ? '+' : ''}${percent.format(lift)}`}</td>
      <td>${percent.format(s.averageLoadFactor)}</td>
      <td>${oneDecimal.format(s.averageRejected)}</td>
      <td>${oneDecimal.format(s.averageEmptySeats)}</td>
      <td>${money.format(s.averageAcceptedFare)}</td>
      <td>${key === 'clairvoyant' ? '—' : money.format(s.averageRegret)}</td>
    </tr>`;
  }).join('');
}

function renderMechanics(result) {
  const protection = result.emsr.protection;
  document.getElementById('emsrMechanics').innerHTML = ['Saver', 'Main', 'Flex'].map(name => `<div><span>${name} request</span><strong>protect ${protection[name] ?? 0} seats</strong></div>`).join('');

  const capacity = result.scenario.capacity;
  const seats = Math.min(25, capacity);
  const checkpoints = [180, 30, 7].map(day => {
    const period = Math.max(0, Math.min(result.scenario.periods - 1, (SIM.DAYS - day) * SIM.SLOTS_PER_DAY));
    const bid = result.dp.bidPrices[period][seats] || 0;
    return { day, bid };
  });
  document.getElementById('dpMechanics').innerHTML = checkpoints.map(row => `<div><span>D-${row.day} · ${seats} seats left</span><strong>${money.format(row.bid)} seat value</strong></div>`).join('');
}

function renderDistribution(result) {
  const policies = [...selectedPolicies(), 'clairvoyant'];
  const summaries = result.summaries;
  const min = Math.min(...policies.map(key => summaries[key].p10));
  const max = Math.max(...policies.map(key => summaries[key].p90));
  const W = 900, H = 330, L = 175, R = 35, T = 28, B = 54;
  const x = value => L + (value - min) / Math.max(max - min, 1) * (W - L - R);
  const rowGap = (H - T - B - 30) / Math.max(policies.length - 1, 1);
  let html = '';
  for (let i = 0; i <= 4; i++) {
    const value = min + i * (max - min) / 4;
    const xx = x(value);
    html += `<line class="scatter-grid" x1="${xx}" y1="${T}" x2="${xx}" y2="${H - B}"></line><text class="scatter-label" x="${xx}" y="${H - 20}" text-anchor="middle">${money.format(value)}</text>`;
  }
  policies.forEach((key, i) => {
    const y = T + 18 + i * rowGap;
    const s = summaries[key];
    html += `<text class="scatter-label" x="8" y="${y + 4}">${policyLabel(key)}</text>`;
    html += `<line x1="${x(s.p10)}" y1="${y}" x2="${x(s.p90)}" y2="${y}" stroke="#1f7a8c" stroke-width="7" stroke-linecap="round" ${key === 'clairvoyant' ? 'stroke-dasharray="6 5"' : ''}></line>`;
    html += `<circle cx="${x(s.averageRevenue)}" cy="${y}" r="7" fill="#c7922b" stroke="white" stroke-width="2"><title>Mean ${money.format(s.averageRevenue)} · P10 ${money.format(s.p10)} · P90 ${money.format(s.p90)}</title></circle>`;
  });
  document.getElementById('optimizerDistribution').innerHTML = html;
}

function renderRepresentative(result) {
  const policies = selectedPolicies();
  const histories = Object.fromEntries(policies.map(key => [key, result.representative[key].history || []]));
  const allRevenue = Object.values(histories).flatMap(rows => rows.map(row => row.revenue));
  const max = Math.max(...allRevenue, 1);
  const W = 900, H = 330, L = 72, R = 34, T = 26, B = 56;
  const x = row => L + (SIM.DAYS - row.day) / SIM.DAYS * (W - L - R);
  const y = value => H - B - value / max * (H - T - B);
  const lineStyle = { open: ['#52606d', '0'], emsr: ['#1f7a8c', '0'], dp: ['#c7922b', '0'] };
  let html = '';
  for (let i = 0; i <= 4; i++) {
    const yy = T + i * (H - T - B) / 4;
    const value = max - i * max / 4;
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="5" y="${yy + 4}">${money.format(value)}</text>`;
  }
  html += `<text class="scatter-label" x="${L}" y="${H - 20}">D-180</text><text class="scatter-label" x="${W - R}" y="${H - 20}" text-anchor="end">Departure</text>`;
  policies.forEach(key => {
    const rows = histories[key];
    if (!rows.length) return;
    const [stroke, dash] = lineStyle[key];
    html += `<polyline points="${rows.map(row => `${x(row)},${y(row.revenue)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"></polyline>`;
    const last = rows[rows.length - 1];
    html += `<text x="${W - R - 3}" y="${Math.max(T + 12, y(last.revenue) - 7)}" text-anchor="end" font-size="11" fill="${stroke}">${policyLabel(key)} ${money.format(last.revenue)}</text>`;
  });
  document.getElementById('optimizerRepresentative').innerHTML = html;
}

function runOptimization() {
  const button = document.getElementById('optimizeButton');
  const status = document.getElementById('optimizerStatus');
  button.disabled = true;
  status.classList.remove('ready');
  status.innerHTML = '<i></i> Running policy experiment';

  try {
    const market = scaledMarket();
    const capacity = Math.max(1, Math.floor(Number(document.getElementById('capacityInput').value || market.capacity || 180)));
    const replications = Math.min(5000, Math.max(50, Math.floor(Number(document.getElementById('replicationsInput').value || 500))));
    const seed = Math.max(1, Math.floor(Number(document.getElementById('seedInput').value || 20260912)));
    const result = SIM.runExperiment({ market, capacity, replications, seed });
    state.result = result;
    renderDecision(result);
    renderRevenueBars(result);
    renderPolicyTable(result);
    renderMechanics(result);
    renderDistribution(result);
    renderRepresentative(result);
    status.classList.add('ready');
    status.innerHTML = `<i></i> ${replications.toLocaleString()} seeded replications complete`;
  } catch (error) {
    console.error(error);
    status.innerHTML = `<i></i> ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function updateMarket(index) {
  state.selected = state.markets[index];
  document.getElementById('capacityInput').value = state.selected.capacity || 180;
  history.replaceState(null, '', `optimizer.html?route=${encodeURIComponent(AY.routeKey(state.selected))}`);
}

function defaultIndex(markets) {
  const requested = new URLSearchParams(window.location.search).get('route');
  if (requested) {
    const normalized = requested.toUpperCase().replace(/→/g, '-').replace(/\s+/g, '');
    const found = markets.findIndex(m => AY.routeKey(m) === normalized);
    if (found >= 0) return found;
  }
  let bestIndex = 0;
  let bestScore = -Infinity;
  markets.forEach((market, index) => {
    const score = AY.opportunityScore(markets, market);
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });
  return bestIndex;
}

async function init() {
  const loaded = await AY.loadMarkets();
  state.markets = loaded.markets;
  const select = document.getElementById('routeSelect');
  select.innerHTML = state.markets.map((m, i) => `<option value="${i}">${m.route || `${m.origin} → ${m.destination}`}</option>`).join('');
  const index = defaultIndex(state.markets);
  select.value = String(index);
  updateMarket(index);

  select.addEventListener('change', () => updateMarket(Number(select.value)));
  document.getElementById('demandScale').addEventListener('input', event => {
    document.getElementById('demandScaleValue').textContent = `${event.target.value}%`;
  });
  document.getElementById('optimizeButton').addEventListener('click', runOptimization);
  document.querySelectorAll('[data-policy]').forEach(input => input.addEventListener('change', () => state.result && runOptimization()));
  runOptimization();
}

init().catch(error => {
  console.error(error);
  const status = document.getElementById('optimizerStatus');
  status.classList.remove('ready');
  status.innerHTML = '<i></i> Could not initialize optimizer';
});
