const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const state = { markets: [], market: null, day: 180, bookings: 0, revenue: 0, rejected: 0, history: [], timer: null, seed: 123456789 };

function rand() {
  state.seed = (1664525 * state.seed + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

function poisson(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k += 1; p *= rand(); } while (p > L && k < 40);
  return k - 1;
}

function classMix(day, m) {
  const progress = 1 - day / 180;
  const saverWeight = Math.max(.10, .70 - .55 * progress);
  const mainWeight = .23 + .17 * progress;
  const flexWeight = .07 + .38 * progress;
  const total = saverWeight + mainWeight + flexWeight;
  const r = rand() * total;
  if (r < saverWeight) return { name:'Saver', fare:m.saverFare };
  if (r < saverWeight + mainWeight) return { name:'Main', fare:m.mainFare };
  return { name:'Flex', fare:m.flexFare };
}

function dailyLambda(day, m) {
  const totalDemand = m.saverDemand + m.mainDemand + m.flexDemand;
  const progress = 1 - day / 180;
  const shape = .35 + 1.7 * Math.pow(progress, 2.2);
  return Math.min(4.5, totalDemand / 180 * shape);
}

function shouldAccept(fc) {
  const remaining = Math.max(0, state.market.capacity - state.bookings);
  if (remaining <= 0) return false;
  const policy = document.getElementById('policySelect').value;
  if (policy === 'open') return true;
  const protect = Number(document.getElementById('premiumProtect').value || 0);
  if (fc.name === 'Saver' && remaining <= protect) return false;
  return true;
}

function updateEvent(fc, accepted) {
  const strip = document.getElementById('eventStrip');
  strip.classList.remove('accept','reject');
  strip.classList.add(accepted ? 'accept' : 'reject');
  document.getElementById('eventMain').textContent = `${fc.name} request at ${money.format(fc.fare)}`;
  document.getElementById('eventDecision').textContent = accepted ? 'ACCEPTED' : 'PROTECTED';
}

function stepDay() {
  if (state.day < 0) { stopSimulation('Departure reached'); return; }
  const arrivals = poisson(dailyLambda(state.day, state.market));
  let latest = null;
  for (let i = 0; i < arrivals; i++) {
    const fc = classMix(state.day, state.market);
    const accepted = shouldAccept(fc);
    if (accepted) { state.bookings += 1; state.revenue += fc.fare; }
    else { state.rejected += 1; }
    latest = { fc, accepted };
  }
  if (latest) updateEvent(latest.fc, latest.accepted);
  state.history.push({ day: state.day, bookings: state.bookings, revenue: state.revenue });
  render();
  state.day -= 1;
}

function renderChart() {
  const svg = document.getElementById('bookingChart');
  const W=760,H=260,L=44,R=20,T=18,B=34;
  let html='';
  for(let i=0;i<=4;i++){
    const yy=T+i*(H-T-B)/4;
    html += `<line class="line-grid" x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}"></line>`;
  }
  html += `<text class="line-label" x="${L}" y="${H-10}">D-180</text><text class="line-label" x="${W-R}" y="${H-10}" text-anchor="end">Departure</text>`;
  if (state.history.length > 1) {
    const maxBookings = Math.max(state.market.capacity, ...state.history.map(h=>h.bookings),1);
    const maxRevenue = Math.max(...state.history.map(h=>h.revenue),1);
    const x = d => L + (180-d)/180*(W-L-R);
    const yB = v => H-B - v/maxBookings*(H-T-B);
    const yR = v => H-B - v/maxRevenue*(H-T-B);
    const bookingsPath = state.history.map((h,i)=>`${i?'L':'M'}${x(h.day).toFixed(1)},${yB(h.bookings).toFixed(1)}`).join(' ');
    const revenuePath = state.history.map((h,i)=>`${i?'L':'M'}${x(h.day).toFixed(1)},${yR(h.revenue).toFixed(1)}`).join(' ');
    html += `<path class="line-path" d="${bookingsPath}"></path><path class="line-path revenue" d="${revenuePath}"></path>`;
  }
  svg.innerHTML = html;
}

function render() {
  const remaining = Math.max(0, state.market.capacity - state.bookings);
  const load = state.market.capacity ? 100*state.bookings/state.market.capacity : 0;
  document.getElementById('twinRouteLabel').textContent = state.market.route;
  document.getElementById('twinDay').textContent = state.day >= 0 ? `D-${state.day}` : 'Departure';
  document.getElementById('twinBookings').textContent = state.bookings;
  document.getElementById('twinRemaining').textContent = remaining;
  document.getElementById('twinRevenue').textContent = money.format(state.revenue);
  document.getElementById('twinRejected').textContent = state.rejected;
  document.getElementById('twinLoad').textContent = `${load.toFixed(1)}%`;
  document.getElementById('capacityUsed').style.width = `${Math.min(100,load)}%`;
  renderChart();
}

function stopSimulation(label='Paused') {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  document.getElementById('runTwin').textContent = state.day < 0 ? 'Run again' : 'Run preview';
  document.getElementById('simulationStatus').textContent = label;
}

function startSimulation() {
  if (state.day < 0) resetSimulation();
  if (state.timer) return;
  document.getElementById('runTwin').textContent = 'Running…';
  document.getElementById('simulationStatus').textContent = 'Simulating';
  state.timer = setInterval(() => {
    for (let i=0;i<3;i++) stepDay();
    if (state.day < 0) stopSimulation('Complete');
  }, 70);
}

function resetSimulation() {
  stopSimulation('Ready');
  state.day = 180; state.bookings = 0; state.revenue = 0; state.rejected = 0; state.history = []; state.seed = 123456789;
  document.getElementById('eventStrip').classList.remove('accept','reject');
  document.getElementById('eventMain').textContent = 'Run the preview to generate bookings.';
  document.getElementById('eventDecision').textContent = 'WAITING';
  render();
}

function setMarket(index) {
  state.market = state.markets[index];
  resetSimulation();
}

async function init() {
  const response = await fetch('data/demo_markets.json');
  if (!response.ok) throw new Error('Could not load demo markets.');
  state.markets = await response.json();
  const select = document.getElementById('twinRoute');
  select.innerHTML = state.markets.map((m,i)=>`<option value="${i}">${m.route}</option>`).join('');
  select.addEventListener('change',()=>setMarket(Number(select.value)));
  document.getElementById('premiumProtect').addEventListener('input',e=>document.getElementById('protectValue').textContent=e.target.value);
  document.getElementById('runTwin').addEventListener('click',startSimulation);
  document.getElementById('resetTwin').addEventListener('click',resetSimulation);
  document.getElementById('policySelect').addEventListener('change',resetSimulation);
  setMarket(0);
}

init().catch(console.error);
