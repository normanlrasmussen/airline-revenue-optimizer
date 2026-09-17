(() => {
  const RM = window.AeroYieldRM;
  const SIM = window.AeroYieldSimulation;
  if (!RM || !SIM) return;

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  const LABELS = {
    lp: 'Deterministic LP',
    bayes: 'Bayesian Adaptive DP',
    dro: 'Distributionally Robust DP',
  };

  const LINE_STYLE = {
    open: ['#52606d', '0'],
    emsr: ['#1f7a8c', '0'],
    dp: ['#c7922b', '0'],
    nn: ['#6d4c8f', '0'],
    lp: ['#246b57', '0'],
    bayes: ['#2f6f9f', '0'],
    dro: ['#9a4a3a', '0'],
  };

  let installed = false;
  let originalRunExperiment = null;

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function selectedPolicyKeys() {
    const selected = [...document.querySelectorAll('[data-policy]')]
      .filter(input => input.checked)
      .map(input => input.dataset.policy);
    return selected.includes('open') ? selected : ['open', ...selected];
  }

  function groupAcceptByBidPrices(policy, event, remaining, period) {
    if (!policy || remaining <= 0 || event.partySize > remaining) return false;
    const t = clamp(Math.floor(period), 0, policy.bidPrices.length - 1);
    let opportunityCost = 0;
    for (let offset = 0; offset < event.partySize; offset++) {
      const row = policy.bidPrices[t];
      const c = clamp(remaining - offset, 1, row.length - 1);
      opportunityCost += Number(row[c] || 0);
    }
    return Number(event.fare) * event.partySize + 1e-12 >= opportunityCost;
  }

  function summarize(rows, oracleAverageRevenue) {
    const n = Math.max(rows.length, 1);
    const sum = key => rows.reduce(
      (total, row) => total + Number(row[key] || 0),
      0
    );
    const totalAccepted = sum('accepted');
    const totalGross = sum('grossRevenue');
    const revenues = rows.map(row => Number(row.revenue || 0));
    const averageRevenue = sum('revenue') / n;

    return {
      averageRevenue,
      averageAccepted: totalAccepted / n,
      averageBoarded: sum('boarded') / n,
      averageRejected: sum('rejected') / n,
      averageCancelled: sum('cancelledSeats') / n,
      averageNoShow: sum('noShowSeats') / n,
      averageDenied: sum('deniedSeats') / n,
      averageRefunds: sum('refunds') / n,
      averageEmptySeats: sum('emptySeats') / n,
      averageLoadFactor: rows.reduce(
        (total, row) => total + Number(row.loadFactor || 0),
        0
      ) / n,
      averageAcceptedFare: totalAccepted ? totalGross / totalAccepted : 0,
      averageRegret: Number(oracleAverageRevenue || 0) - averageRevenue,
      revenues,
      p10: SIM.quantile(revenues, 0.10),
      p50: SIM.quantile(revenues, 0.50),
      p90: SIM.quantile(revenues, 0.90),
    };
  }

  function buildBayesianGrid(scenario) {
    const scales = [0.50, 0.65, 0.80, 0.95, 1.10, 1.30, 1.50, 1.75];
    const policies = scales.map(scale => ({
      scale,
      dp: RM.buildDP(
        scenario.bookingLimit,
        scenario.fares,
        RM.scaleProbabilitySchedule(scenario.forecastProbabilities, scale)
      ),
    }));

    const expectedCumulative = [];
    let cumulative = 0;
    for (let t = 0; t < scenario.periods; t++) {
      cumulative += Object.values(scenario.forecastProbabilities[t])
        .reduce((sum, probability) => sum + Number(probability || 0), 0);
      expectedCumulative.push(cumulative);
    }

    return { scales, policies, expectedCumulative, priorStrength: 30 };
  }

  function nearestBayesianPolicy(grid, posteriorScale) {
    return grid.policies.reduce(
      (best, candidate) =>
        Math.abs(candidate.scale - posteriorScale) < Math.abs(best.scale - posteriorScale)
          ? candidate
          : best,
      grid.policies[0]
    );
  }

  function makeBayesianAccept(scenario, grid) {
    let observedSeatRequests = 0;
    let lastScale = 1;

    const accept = (event, remaining, period) => {
      observedSeatRequests += Number(event.partySize || 1);
      const expectedExposure = Number(grid.expectedCumulative[period] || 0);
      const posteriorScale = RM.gammaPoissonScale(
        observedSeatRequests,
        expectedExposure,
        grid.priorStrength,
        0.5,
        1.75
      );
      lastScale = posteriorScale;
      const selected = nearestBayesianPolicy(grid, posteriorScale);
      return groupAcceptByBidPrices(selected.dp, event, remaining, period);
    };

    accept.posteriorScale = () => lastScale;
    return accept;
  }

  function augmentExperiment(result) {
    const scenario = result.scenario;
    const assumptions = result.assumptions;
    const count = result.replications;
    const baseSeed = result.seed >>> 0;

    const lp = RM.buildLPBidPricePolicy(
      scenario.bookingLimit,
      scenario.fares,
      scenario.forecastProbabilities
    );
    const droRadius = clamp(Number(assumptions.forecastErrorPct || 0) / 200, 0, 0.20);
    const dro = RM.buildRobustDP(
      scenario.bookingLimit,
      scenario.fares,
      scenario.forecastProbabilities,
      droRadius
    );
    const bayesianGrid = buildBayesianGrid(scenario);

    const runs = { lp: [], bayes: [], dro: [] };
    const representative = {};
    let representativePosteriorScale = 1;

    for (let rep = 0; rep < count; rep++) {
      const repSeed = (baseSeed + Math.imul(rep, 0x9e3779b9)) >>> 0;
      const events = SIM.generateStream(scenario, repSeed, assumptions);
      const capture = rep === 0;

      const lpRun = SIM.runPolicy(
        events,
        scenario,
        (event, remaining, period) => groupAcceptByBidPrices(
          lp,
          event,
          remaining,
          period
        ),
        capture,
        assumptions
      );

      const bayesAccept = makeBayesianAccept(scenario, bayesianGrid);
      const bayesRun = SIM.runPolicy(
        events,
        scenario,
        bayesAccept,
        capture,
        assumptions
      );

      const droRun = SIM.runPolicy(
        events,
        scenario,
        (event, remaining, period) => groupAcceptByBidPrices(
          dro,
          event,
          remaining,
          period
        ),
        capture,
        assumptions
      );

      runs.lp.push(lpRun);
      runs.bayes.push(bayesRun);
      runs.dro.push(droRun);

      if (capture) {
        representative.lp = lpRun;
        representative.bayes = bayesRun;
        representative.dro = droRun;
        representativePosteriorScale = bayesAccept.posteriorScale();
      }
    }

    const oracleAverage = result.summaries.clairvoyant.averageRevenue;
    result.summaries.lp = summarize(runs.lp, oracleAverage);
    result.summaries.bayes = summarize(runs.bayes, oracleAverage);
    result.summaries.dro = summarize(runs.dro, oracleAverage);
    result.representative.lp = representative.lp;
    result.representative.bayes = representative.bayes;
    result.representative.dro = representative.dro;
    result.lp = lp;
    result.bayesian = {
      scaleGrid: bayesianGrid.scales,
      priorStrength: bayesianGrid.priorStrength,
      representativePosteriorScale,
      interpretation: 'Gamma-Poisson booking-pace update with certainty-equivalent DP selection',
    };
    result.dro = {
      ...dro,
      ambiguityRadius: droRadius,
      ambiguityMetric: 'total variation',
    };
    return result;
  }

  function installExperimentWrapper() {
    if (installed) return;
    originalRunExperiment = SIM.runExperiment.bind(SIM);
    SIM.runExperiment = options => augmentExperiment(originalRunExperiment(options));
    installed = true;
  }

  function patchPolicyLabel() {
    if (typeof window.policyLabel !== 'function' || window.policyLabel.__advancedPatched) return;
    const original = window.policyLabel;
    const patched = key => LABELS[key] || original(key);
    patched.__advancedPatched = true;
    window.policyLabel = patched;
  }

  function patchRepresentativeRenderer() {
    if (typeof window.renderRepresentative !== 'function') return;
    window.renderRepresentative = result => {
      const policies = selectedPolicyKeys();
      const histories = Object.fromEntries(
        policies.map(key => [key, result.representative[key]?.history || []])
      );
      const allRevenue = Object.values(histories)
        .flatMap(rows => rows.map(row => row.revenue));
      const minRevenue = Math.min(0, ...allRevenue);
      const maxRevenue = Math.max(1, ...allRevenue);
      const W = 900, H = 330, L = 72, R = 34, T = 58, B = 56;
      const x = row => L + (SIM.DAYS - row.day) / SIM.DAYS * (W - L - R);
      const y = value => H - B - (value - minRevenue) /
        Math.max(maxRevenue - minRevenue, 1) * (H - T - B);

      let html = '';
      const labelFor = key => LABELS[key] || (typeof window.policyLabel === 'function' ? window.policyLabel(key) : key);
      const legendItems = policies.map(key => ({
        key,
        label: labelFor(key),
        width: labelFor(key).length * 6.5 + 32,
      }));
      const legendWidth = legendItems.reduce((sum, item) => sum + item.width, 0) + 16;
      const legendX = Math.max(L, W - R - legendWidth);

      html += `<g aria-label="Policy legend"><rect class="svg-legend-bg" x="${legendX}" y="10" width="${legendWidth}" height="32" rx="8"></rect>`;
      let itemX = legendX + 10;
      legendItems.forEach(item => {
        const [stroke] = LINE_STYLE[item.key] || ['#52606d', '0'];
        html += `<line x1="${itemX}" y1="26" x2="${itemX + 18}" y2="26" stroke="${stroke}" stroke-width="4" stroke-linecap="round"></line>`;
        html += `<text class="svg-legend-text" x="${itemX + 24}" y="30">${item.label}</text>`;
        itemX += item.width;
      });
      html += '</g>';

      for (let i = 0; i <= 4; i++) {
        const yy = T + i * (H - T - B) / 4;
        const value = maxRevenue - i * (maxRevenue - minRevenue) / 4;
        html += `<line class="scatter-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"></line><text class="scatter-label" x="5" y="${yy + 4}">${money.format(value)}</text>`;
      }

      html += `<text class="scatter-label" x="${L}" y="${H - 20}">D-180</text><text class="scatter-label" x="${W - R}" y="${H - 20}" text-anchor="end">Departure</text>`;

      policies.forEach(key => {
        const rows = histories[key];
        if (!rows.length) return;
        const [stroke, dash] = LINE_STYLE[key] || ['#52606d', '0'];
        const finalRevenue = rows[rows.length - 1].revenue;
        html += `<polyline points="${rows.map(row => `${x(row)},${y(row.revenue)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"><title>${labelFor(key)} · final net revenue ${money.format(finalRevenue)}</title></polyline>`;
      });

      document.getElementById('optimizerRepresentative').innerHTML = html;
    };
  }

  function renderAdvancedMechanics(result) {
    const lpTarget = document.getElementById('lpMechanics');
    const bayesTarget = document.getElementById('bayesMechanics');
    const droTarget = document.getElementById('droMechanics');
    if (!lpTarget || !bayesTarget || !droTarget) return;

    const t = Math.max(0, result.scenario.periods - 1 - 30 * SIM.SLOTS_PER_DAY);
    const c = Math.min(25, result.scenario.bookingLimit);
    lpTarget.textContent = `D-30 bid price with ${c} booking spaces: ${money.format(result.lp.bidPrices[t][c] || 0)}`;
    bayesTarget.textContent = `Representative final posterior demand scale: ${Number(result.bayesian.representativePosteriorScale || 1).toFixed(2)}× baseline`;
    droTarget.textContent = `Total-variation ambiguity radius: ${(100 * Number(result.dro.ambiguityRadius || 0)).toFixed(1)}%`;
  }

  function patchMechanicsRenderer() {
    if (typeof window.renderMechanics !== 'function' || window.renderMechanics.__advancedPatched) return;
    const original = window.renderMechanics;
    const patched = result => {
      original(result);
      renderAdvancedMechanics(result);
    };
    patched.__advancedPatched = true;
    window.renderMechanics = patched;
  }

  function insertPolicyControls() {
    if (document.querySelector('[data-policy="lp"]')) return;
    const dpInput = document.querySelector('[data-policy="dp"]');
    let anchor = dpInput?.closest('label');
    if (!anchor) return;

    const specs = [
      {
        key: 'lp',
        name: 'Deterministic LP',
        text: 'Uses the baseline remaining-demand LP shadow price as a time-varying per-seat booking threshold.',
      },
      {
        key: 'bayes',
        name: 'Bayesian Adaptive DP',
        text: 'Updates a Gamma-Poisson market demand multiplier from observed booking pace and switches among pre-solved forecast DPs.',
      },
      {
        key: 'dro',
        name: 'Distributionally Robust DP',
        text: 'Uses a robust Bellman recursion over probability distributions near the baseline forecast in total-variation distance.',
      },
    ];

    specs.forEach(spec => {
      const label = document.createElement('label');
      label.className = 'policy-check';
      label.innerHTML = `<input type="checkbox" data-policy="${spec.key}" checked /><span><strong>${spec.name}</strong><small>${spec.text}</small></span>`;
      anchor.insertAdjacentElement('afterend', label);
      anchor = label;
      label.querySelector('input').addEventListener('change', () => {
        if (typeof window.runOptimization === 'function') window.runOptimization();
      });
    });
  }

  function insertMechanicsCards() {
    const grid = document.querySelector('.mechanics-grid');
    if (!grid || document.getElementById('lpMechanics')) return;
    grid.insertAdjacentHTML('beforeend', `
      <article class="card"><div class="number">DETERMINISTIC LP</div><h3>Expected-demand shadow price</h3><p>Re-solves the single-resource deterministic relaxation against remaining baseline demand. It accepts a request when fare per seat covers the capacity shadow price.</p><div class="mechanic-value"><span>Current diagnostic</span><strong id="lpMechanics">—</strong></div></article>
      <article class="card"><div class="number">BAYESIAN ADAPTIVE DP</div><h3>Learn from booking pace</h3><p>Starts from the baseline forecast, updates a Gamma-Poisson demand multiplier using observed seat requests, and uses the nearest pre-solved DP policy. This is certainty-equivalent adaptation, not an exact Bayes-adaptive MDP.</p><div class="mechanic-value"><span>Current diagnostic</span><strong id="bayesMechanics">—</strong></div></article>
      <article class="card"><div class="number">DISTRIBUTIONALLY ROBUST DP</div><h3>Protect against forecast misspecification</h3><p>At each Bellman step, an adversary may move probability mass inside a total-variation ambiguity set around the baseline request distribution.</p><div class="mechanic-value"><span>Current diagnostic</span><strong id="droMechanics">—</strong></div></article>
    `);
  }

  function insertMethodDetails() {
    const stack = document.querySelector('.method-stack');
    if (!stack || document.getElementById('advancedPolicyDetails')) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'advancedPolicyDetails';
    wrapper.innerHTML = `
      <details class="method-details"><summary>Deterministic LP: single-leg bid-price control</summary><div><p>The policy solves the deterministic expected-demand relaxation for the remaining horizon. With one capacity resource, sorting fare classes by fare gives the LP solution directly; the marginal class fare is the capacity shadow price. A group is accepted only when its total fare covers the summed per-seat bid prices.</p><p><strong>Guarantee:</strong> exact for the deterministic LP relaxation, not for the stochastic realized booking process.</p></div></details>
      <details class="method-details"><summary>Bayesian Adaptive DP: booking-pace learning without future information</summary><div><p>The controller treats total demand intensity as an unknown multiplier on the baseline forecast. A Gamma prior and observed cumulative seat requests produce a Gamma-Poisson posterior mean. The controller then selects the closest pre-solved DP from a grid of demand multipliers.</p><p><strong>Information boundary:</strong> it uses only requests observed so far. It never sees future arrivals, cancellations, no-shows, or the realized demand shock. <strong>Guarantee:</strong> this is a certainty-equivalent adaptive controller, not the exact Bayes-adaptive MDP.</p></div></details>
      <details class="method-details"><summary>Distributionally Robust DP: total-variation ambiguity</summary><div><p>For each booking period, the baseline categorical distribution over no-request/Saver/Main/Flex outcomes is surrounded by a total-variation ball. The robust Bellman recursion evaluates the worst expected continuation value inside that ball before computing bid prices. The ambiguity radius is tied to the experiment's assumed demand-uncertainty setting, not to the realized future.</p><p><strong>Guarantee:</strong> exact for the stated rectangular total-variation ambiguity model.</p></div></details>
    `;
    while (wrapper.firstChild) stack.appendChild(wrapper.firstChild);
  }

  function bootstrap() {
    patchPolicyLabel();
    patchRepresentativeRenderer();
    patchMechanicsRenderer();
    insertPolicyControls();
    insertMechanicsCards();
    insertMethodDetails();
    installExperimentWrapper();

    if (
      typeof window.runOptimization === 'function'
      && document.getElementById('bestPolicyName')?.textContent !== '—'
    ) {
      window.runOptimization();
    }
  }

  window.AeroYieldAdvancedPolicies = {
    bootstrap,
    augmentExperiment,
    groupAcceptByBidPrices,
    buildBayesianGrid,
  };

  bootstrap();
})();
