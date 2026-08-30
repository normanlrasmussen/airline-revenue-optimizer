const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat('en-US');

const state = { markets: [], selected: null };

function optimizeSeats(capacity, classes) {
  // Deliberately simple deterministic integer optimization.
  // For an aircraft-sized capacity and three fare classes, exhaustive enumeration is transparent and fast.
  let best = { revenue: -1, allocation: {} };
  const [a, b, c] = classes;

  for (let xa = 0; xa <= a.demand; xa++) {
    for (let xb = 0; xb <= b.demand; xb++) {
      const used = xa + xb;
      if (used > capacity) break;
      const maxC = Math.min(c.demand, capacity - used);
      // Since fares are non-negative, the best x_c for fixed x_a/x_b is the largest feasible value.
      const xc = maxC;
      const revenue = xa * a.fare + xb * b.fare + xc * c.fare;
      if (revenue > best.revenue) {
        best = { revenue, allocation: { [a.name]: xa, [b.name]: xb, [c.name]: xc } };
      }
    }
  }
  return best;
}

function baseline(capacity, classes) {
  let remaining = capacity;
  let revenue = 0;
  const allocation = {};
  [...classes].sort((x, y) => x.fare - y.fare).forEach(fc => {
    const seats = Math.min(fc.demand, remaining);
    allocation[fc.name] = seats;
    revenue += seats * fc.fare;
    remaining -= seats;
  });
  classes.forEach(fc => allocation[fc.name] ??= 0);
  return { revenue, allocation };
}

function classesFromInputs() {
  return ['Saver', 'Main', 'Flex'].map(name => ({
    name,
    fare: Number(document.querySelector(`[data-fare="${name}"]`).value || 0),
    demand: Math.max(0, Math.floor(Number(document.querySelector(`[data-demand="${name}"]`).value || 0)))
  }));
}

function renderControls(market) {
  const classes = [
    { name: 'Saver', fare: market.saverFare, demand: market.saverDemand },
    { name: 'Main', fare: market.mainFare, demand: market.mainDemand },
    { name: 'Flex', fare: market.flexFare, demand: market.flexDemand },
  ];
  document.getElementById('fareControls').innerHTML = classes.map(fc => `
    <div class="fare-row">
      <div class="fare-class-name">${fc.name}</div>
      <input aria-label="${fc.name} fare" data-fare="${fc.name}" type="number" min="0" step="1" value="${fc.fare}" />
      <input aria-label="${fc.name} demand" data-demand="${fc.name}" type="number" min="0" step="1" value="${fc.demand}" />
    </div>`).join('');
  document.getElementById('capacityInput').value = market.capacity;
}

function updateMarket(market) {
  state.selected = market;
  document.getElementById('originCode').textContent = market.origin;
  document.getElementById('destinationCode').textContent = market.destination;
  document.getElementById('marketFare').textContent = money.format(market.avgFare);
  document.getElementById('marketPassengers').textContent = integer.format(market.passengers);
  document.getElementById('marketCapacity').textContent = integer.format(market.capacity);
  document.getElementById('kpiRoute').textContent = market.route;
  document.getElementById('kpiAvgFare').textContent = money.format(market.avgFare);
  document.getElementById('kpiPassengers').textContent = integer.format(market.passengers);
  document.getElementById('heroFare').textContent = money.format(market.avgFare);
  renderControls(market);
  runOptimization();
}

function renderAllocation(allocation, capacity) {
  const order = ['Saver', 'Main', 'Flex'];
  const used = order.reduce((sum, name) => sum + (allocation[name] || 0), 0);
  const empty = Math.max(0, capacity - used);
  const visual = document.getElementById('allocationVisual');
  visual.innerHTML = order.map(name => {
    const seats = allocation[name] || 0;
    const width = capacity ? (100 * seats / capacity) : 0;
    return `<div class="seat-block ${name.toLowerCase()}" style="width:${width}%" title="${name}: ${seats}">${seats || ''}</div>`;
  }).join('') + (empty ? `<div class="seat-block empty" style="width:${100 * empty / capacity}%">${empty}</div>` : '');

  const colors = { Saver: '#526f82', Main: '#1f7a8c', Flex: '#c7922b', Empty: '#29465b' };
  document.getElementById('allocationLegend').innerHTML = [
    ...order.map(name => `${name}: ${allocation[name] || 0}`),
    ...(empty ? [`Empty: ${empty}`] : [])
  ].map(text => {
    const name = text.split(':')[0];
    return `<span><i class="legend-dot" style="background:${colors[name]}"></i>${text}</span>`;
  }).join('');
}

function runOptimization() {
  const capacity = Math.max(0, Math.floor(Number(document.getElementById('capacityInput').value || 0)));
  const classes = classesFromInputs();
  const optimized = optimizeSeats(capacity, classes);
  const base = baseline(capacity, classes);
  const lift = optimized.revenue - base.revenue;
  const liftPct = base.revenue ? 100 * lift / base.revenue : 0;
  const seatsSold = Object.values(optimized.allocation).reduce((a, b) => a + b, 0);
  const load = capacity ? 100 * seatsSold / capacity : 0;

  document.getElementById('optimizedRevenue').textContent = money.format(optimized.revenue);
  document.getElementById('optimizedRevenueBar').textContent = money.format(optimized.revenue);
  document.getElementById('baselineRevenue').textContent = money.format(base.revenue);
  document.getElementById('liftPill').textContent = `+${money.format(lift)} · ${liftPct.toFixed(1)}%`;
  document.getElementById('kpiLift').textContent = `+${money.format(lift)}`;
  document.getElementById('heroLift').textContent = `+${money.format(lift)}`;
  document.getElementById('heroCapacity').textContent = integer.format(capacity);
  document.getElementById('heroLoad').textContent = `${load.toFixed(1)}%`;

  const maxRev = Math.max(optimized.revenue, base.revenue, 1);
  document.getElementById('baselineBar').style.width = `${100 * base.revenue / maxRev}%`;
  document.getElementById('optimizedBar').style.width = `${100 * optimized.revenue / maxRev}%`;
  renderAllocation(optimized.allocation, capacity);
}

async function init() {
  const response = await fetch('data/demo_markets.json');
  if (!response.ok) throw new Error(`Failed to load demo markets: ${response.status}`);
  state.markets = await response.json();
  if (!state.markets.length) throw new Error('No market scenarios found.');

  const select = document.getElementById('routeSelect');
  select.innerHTML = state.markets.map((m, i) => `<option value="${i}">${m.route}</option>`).join('');
  select.addEventListener('change', () => updateMarket(state.markets[Number(select.value)]));
  document.getElementById('optimizeButton').addEventListener('click', runOptimization);
  document.getElementById('resetButton').addEventListener('click', () => updateMarket(state.selected));
  updateMarket(state.markets[0]);
}

init().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;bottom:16px;right:16px;background:#fff3cd;padding:12px 14px;border-radius:8px">Could not load demo data.</div>');
});
