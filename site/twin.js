const AY = window.AeroYieldData;
const SIM = window.AeroYieldSimulation;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const state = { markets: [], market: null, result: null };

async function loadMarkets() {
  const loaded = await AY.loadMarkets();
  return loaded.markets;
}

function policyLabel(key) {
  return { open: 'Open Sales', emsr: 'EMSR-b', dp: 'Dynamic Programming', clairvoyant: 'Clairvoyant' }[key] || key;
}

function averageLift(summary, baseline) {
  return baseline.averageRevenue ? summary.averageRevenue / baseline.averageRevenue - 1 : 0;
}

function setRevenueBars(result) {
  const summaries = result.summaries;
  const max = Math.max(...Object.values(summaries).map(s => s.averageRevenue), 1);
  for (const key of ['open', 'emsr', 'dp', 'clairvoyant']) {
    const prefix = key === 'clairvoyant' ? 'clair' : key;
    document.getElementById(`${prefix}Revenue`).textContent = money.format(summaries[key].averageRevenue);
    document.getElementById(`${prefix}RevenueBar`).style.width = `${100 * summaries[key].averageRevenue / max}%`;
  }

  const deployable = ['open', 'emsr', 'dp'].sort((a, b) => summaries[b].averageRevenue - summaries[a].averageRevenue);
  const best = deployable[0];
  const lift = averageLift(summaries[best], summaries.open);
  document.getElementById('bestPolicy').textContent = policyLabel(best);
  document.getElementById('bestLift').textContent = best === 'open' ? 'Baseline is best' : `${lift >= 0 ? '+' : ''}${percent.format(lift)} vs Open`;
}

function renderPolicyTable(result) {
  const summaries = result.summaries;
  const rows = ['open', 'emsr', 'dp', 'clairvoyant'];
  document.getElementById('policyTableBody').innerHTML = rows.map(key => {
    const s = summaries[key];
    const lift = averageLift(s, summaries.open);
    const liftText = key === 'open' ? 'Baseline' : `${lift >= 0 ? '+' : ''}${percent.format(lift)}`;
    return `<tr>
      <td><strong>${policyLabel(key)}</strong></td>
      <td>${money.format(s.averageRevenue)}</td>
      <td>${liftText}</td>
      <td>${percent.format(s.averageLoadFactor)}</td>
      <td>${number.format(s.averageRejected)}</td>
      <td>${number.format(s.averageEmptySeats)}</td>
      <td>${money.format(s.averageAcceptedFare)}</td>
      <td>${key === 'clairvoyant' ? '—' : money.format(s.averageRegret)}</td>
    </tr>`;
  }).join('');
}

function renderDistribution(result) {
  const svg = document.getElementById('distributionChart');
  const rows = ['open', 'emsr', 'dp', 'clairvoyant'];
  const summaries = result.summaries;
  const min = Math.min(...rows.map(key => summaries[key].p10));
  const max = Math.max(...rows.map(key => summaries[key].p90));
  const W = 900, H = 330, L = 155, R = 35, T = 30, B = 54;
  const x = value => L + (value - min) / Math.max(max - min, 1) * (W - L - R);
  let html = '';

  for (let i = 0; i <= 4; i++) {
    const value = min + i * (max - min) / 4;
    const xx = x(value);
    html += `<line class="scatter-grid" x1="${xx}" y1="${T}" x2="${xx}" y2="${H - B}"></line><text class="scatter-label" x="${xx}" y="${H - 22}" text-anchor="middle">${money.format(value)}</text>`;
  }

  rows.forEach((key, i) => {
    const y = T + 35 + i * 56;
    const s = summaries[key];
    const dash = key === 'clairvoyant' ? '6 5' : '0';
    html += `<text class="scatter-label" x="8" y="${y + 4}">${policyLabel(key)}</text>`;
    html += `<line x1="${x(s.p10)}" y1="${y}" x2="${x(s.p90)}" y2="${y}" stroke="#1f7a8c" stroke-width="7" stroke-linecap="round" stroke-dasharray="${dash}"></line>`;
    html += `<circle cx="${x(s.averageRevenue)}" cy="${y}" r="7" fill="#c7922b" stroke="white" stroke-width="2"><title>Mean ${money.format(s.averageRevenue)} · P10 ${money.format(s.p10)} · P90 ${money.format(s.p90)}</title></circle>`;
  });
  svg.innerHTML = html;
}

function renderRepresentative(result) {
  const svg = document.getElementById('representativeChart');
  const histories = {
    open: result.representative.open.history || [],
    emsr: result.representative.emsr.history || [],
    dp: result.representative.dp.history || [],
  };
  const all = Object.values(histories).flatMap(rows => rows.map(row => row.revenue));
  const max = Math.max(...all, 1);
  const W = 900, H = 330, L = 72, R = 34, T = 26, B = 56;
  const x = row => L + (SIM.DAYS - row.day) / SIM.DAYS * (W - L - R);
  const y = value => H - B - value / max * (H - T - B);
  let html = '';

  for (let i = 0; i <= 4; i++) {
    const yy = T + i * (H - T - B) / 4;
    const value = max - i * max / 4;
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="5" y="${yy + 4}">${money.format(value)}</text>`;
  }
  html += `<text class="scatter-label" x="${L}" y="${H - 20}">D-180</text><text class="scatter-label" x="${W - R}" y="${H - 20}" text-anchor="end">Departure</text>`;
  const styles = { open: ['#52606d', '0'], emsr: ['#1f7a8c', '0'], dp: ['#c7922b', '0'] };
  for (const key of ['open', 'emsr', 'dp']) {
    const rows = histories[key];
    if (!rows.length) continue;
    const [stroke, dash] = styles[key];
    const points = rows.map(row => `${x(row)},${y(row.revenue)}`).join(' ');
    html += `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"></polyline>`;
    const last = rows[rows.length - 1];
    html += `<text x="${W - R - 4}" y="${Math.max(T + 12, y(last.revenue) - 8)}" text-anchor="end" font-size="11" fill="${stroke}">${policyLabel(key)} ${money.format(last.revenue)}</text>`;
  }
  svg.innerHTML = html;
}

function runExperiment() {
  const button = document.getElementById('runExperiment');
  const status = document.getElementById('simStatus');
  button.disabled = true;
  status.innerHTML = '<i></i> Running';

  try {
    const capacity = Math.max(1, Math.floor(Number(document.getElementById('simCapacity').value || state.market.capacity || 180)));
    const replications = Math.min(5000, Math.max(10, Math.floor(Number(document.getElementById('simReplications').value || 500))));
    const seed = Math.max(1, Math.floor(Number(document.getElementById('simSeed').value || 20260912)));
    const result = SIM.runExperiment({ market: state.market, capacity, replications, seed });
    state.result = result;
    setRevenueBars(result);
    renderPolicyTable(result);
    renderDistribution(result);
    renderRepresentative(result);
    status.classList.add('ready');
    status.innerHTML = `<i></i> ${replications.toLocaleString()} seeded replications complete`;
  } catch (error) {
    console.error(error);
    status.classList.remove('ready');
    status.innerHTML = `<i></i> ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function setMarket(index) {
  state.market = state.markets[index];
  document.getElementById('simCapacity').value = state.market.capacity || 180;
}

async function init() {
  state.markets = await loadMarkets();
  const select = document.getElementById('simRoute');
  select.innerHTML = state.markets.map((m, i) => `<option value="${i}">${m.route || `${m.origin} → ${m.destination}`}</option>`).join('');
  select.addEventListener('change', () => setMarket(Number(select.value)));
  document.getElementById('runExperiment').addEventListener('click', runExperiment);
  setMarket(0);
  runExperiment();
}

init().catch(error => {
  console.error(error);
  const status = document.getElementById('simStatus');
  status.classList.remove('ready');
  status.innerHTML = '<i></i> Could not initialize simulator';
});
