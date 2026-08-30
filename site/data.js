const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat('en-US');
const state = { markets: [], selectedIndex: 0 };

function totalDemand(m) { return m.saverDemand + m.mainDemand + m.flexDemand; }

function renderPassengerBars() {
  const max = Math.max(...state.markets.map(m => m.passengers), 1);
  document.getElementById('passengerBars').innerHTML = state.markets.map((m, i) => `
    <button type="button" class="bar-row" data-market="${i}" style="border:0;background:transparent;padding:0;width:100%;text-align:left">
      <span class="bar-label">${m.origin}–${m.destination}</span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${100 * m.passengers / max}%"></span></span>
      <span class="bar-value">${integer.format(m.passengers)}</span>
    </button>`).join('');
  document.querySelectorAll('[data-market]').forEach(el => el.addEventListener('click', () => selectMarket(Number(el.dataset.market))));
}

function renderScatter() {
  const svg = document.getElementById('fareScatter');
  const W = 720, H = 290, L = 62, R = 28, T = 20, B = 45;
  const fares = state.markets.map(m => m.avgFare), pax = state.markets.map(m => m.passengers);
  const minX = Math.min(...fares) - 15, maxX = Math.max(...fares) + 15;
  const minY = Math.max(0, Math.min(...pax) - 1500), maxY = Math.max(...pax) + 1500;
  const x = v => L + (v - minX) / (maxX - minX) * (W - L - R);
  const y = v => H - B - (v - minY) / (maxY - minY) * (H - T - B);
  let html = '';
  for (let i = 0; i <= 4; i++) {
    const yy = T + i * (H - T - B) / 4;
    const val = maxY - i * (maxY - minY) / 4;
    html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}"></line><text class="scatter-label" x="8" y="${yy+4}">${Math.round(val/1000)}k</text>`;
  }
  html += `<line class="scatter-axis" x1="${L}" y1="${H-B}" x2="${W-R}" y2="${H-B}"></line><line class="scatter-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H-B}"></line>`;
  [minX, (minX+maxX)/2, maxX].forEach(v => { html += `<text class="scatter-label" x="${x(v)}" y="${H-15}" text-anchor="middle">$${Math.round(v)}</text>`; });
  state.markets.forEach((m, i) => {
    html += `<g data-point="${i}" tabindex="0" role="button" aria-label="${m.route}, average fare ${money.format(m.avgFare)}, ${integer.format(m.passengers)} passengers"><circle class="scatter-point ${i === state.selectedIndex ? 'active' : ''}" cx="${x(m.avgFare)}" cy="${y(m.passengers)}" r="8"></circle><text class="scatter-label" x="${x(m.avgFare)+10}" y="${y(m.passengers)-10}">${m.origin}–${m.destination}</text></g>`;
  });
  svg.innerHTML = html;
  svg.querySelectorAll('[data-point]').forEach(el => {
    const activate = () => selectMarket(Number(el.dataset.point));
    el.addEventListener('click', activate);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
  });
}

function renderFareBars(m) {
  const rows = [
    { name:'Saver', fare:m.saverFare, demand:m.saverDemand },
    { name:'Main', fare:m.mainFare, demand:m.mainDemand },
    { name:'Flex', fare:m.flexFare, demand:m.flexDemand }
  ];
  const maxFare = Math.max(...rows.map(r => r.fare), 1);
  document.getElementById('fareChartRoute').textContent = `${m.route} · bars scaled by fare`;
  document.getElementById('fareBars').innerHTML = rows.map(r => `
    <div class="bar-row"><span class="bar-label">${r.name}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${100*r.fare/maxFare}%"></span></span><span class="bar-value">${money.format(r.fare)} · d=${r.demand}</span></div>`).join('');
}

function selectMarket(index) {
  state.selectedIndex = index;
  const m = state.markets[index];
  document.getElementById('routeSelect').value = String(index);
  document.getElementById('selectedRoute').textContent = m.route;
  document.getElementById('selectedFare').textContent = money.format(m.avgFare);
  document.getElementById('selectedPassengers').textContent = integer.format(m.passengers);
  document.getElementById('selectedCapacity').textContent = integer.format(m.capacity);
  document.getElementById('selectedDemand').textContent = integer.format(totalDemand(m));
  renderScatter();
  renderFareBars(m);
}

async function init() {
  const response = await fetch('data/demo_markets.json');
  if (!response.ok) throw new Error('Could not load demo markets.');
  state.markets = await response.json();
  document.getElementById('marketCount').textContent = state.markets.length;
  document.getElementById('totalPassengers').textContent = integer.format(state.markets.reduce((s,m) => s + m.passengers, 0));
  document.getElementById('meanFare').textContent = money.format(state.markets.reduce((s,m) => s + m.avgFare, 0) / state.markets.length);
  const select = document.getElementById('routeSelect');
  select.innerHTML = state.markets.map((m,i) => `<option value="${i}">${m.route}</option>`).join('');
  select.addEventListener('change', () => selectMarket(Number(select.value)));
  renderPassengerBars();
  selectMarket(0);
}

init().catch(console.error);
