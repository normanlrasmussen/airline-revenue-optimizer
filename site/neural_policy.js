(() => {
  const SIM = window.AeroYieldSimulation;
  const CLASS_ORDER = ['Saver', 'Main', 'Flex'];
  const EXPECTED_FEATURES = [
    'booking_progress',
    'remaining_capacity_fraction',
    'party_size_fraction',
    'request_fare_to_flex',
    'saver_fare_to_flex',
    'main_fare_to_flex',
    'flex_fare_to_flex',
    'saver_demand_per_booking_space',
    'main_demand_per_booking_space',
    'flex_demand_per_booking_space',
    'total_demand_per_booking_space',
    'saver_request_probability_now',
    'main_request_probability_now',
    'flex_request_probability_now',
    'total_request_probability_now',
    'is_saver',
    'is_main',
    'is_flex',
  ];

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  let model = null;
  let wrapped = false;
  let originalRunExperiment = null;

  function sigmoid(value) {
    if (value >= 0) {
      const z = Math.exp(-value);
      return 1 / (1 + z);
    }
    const z = Math.exp(value);
    return z / (1 + z);
  }

  function validateModel(candidate) {
    if (!candidate || candidate.schemaVersion !== 1) {
      throw new Error('Unsupported neural-policy model schema.');
    }
    if (!Array.isArray(candidate.featureNames)) {
      throw new Error('Neural-policy model is missing featureNames.');
    }
    if (
      candidate.featureNames.length !== EXPECTED_FEATURES.length
      || candidate.featureNames.some((name, i) => name !== EXPECTED_FEATURES[i])
    ) {
      throw new Error('Neural-policy feature schema does not match this site build.');
    }
    if (!candidate.scaler || !Array.isArray(candidate.layers) || !candidate.layers.length) {
      throw new Error('Neural-policy model is incomplete.');
    }
    return candidate;
  }

  function byClass(scenario) {
    return Object.fromEntries(scenario.classes.map(fc => [fc.name, fc]));
  }

  function featureVector(scenario, event, remaining, period) {
    const classes = byClass(scenario);
    const flexFare = Math.max(Number(classes.Flex.fare || 0), 1e-9);
    const current = scenario.forecastProbabilities[period] || {};
    const totalDemand = CLASS_ORDER.reduce(
      (sum, name) => sum + Number(classes[name].meanDemand || 0),
      0
    );
    const currentTotal = CLASS_ORDER.reduce(
      (sum, name) => sum + Number(current[name] || 0),
      0
    );
    const bookingLimit = Math.max(Number(scenario.bookingLimit || 1), 1);

    return [
      period / Math.max(scenario.periods - 1, 1),
      remaining / bookingLimit,
      Number(event.partySize || 1) / 4,
      Number(event.fare || 0) / flexFare,
      Number(classes.Saver.fare || 0) / flexFare,
      Number(classes.Main.fare || 0) / flexFare,
      Number(classes.Flex.fare || 0) / flexFare,
      Number(classes.Saver.meanDemand || 0) / bookingLimit,
      Number(classes.Main.meanDemand || 0) / bookingLimit,
      Number(classes.Flex.meanDemand || 0) / bookingLimit,
      totalDemand / bookingLimit,
      Number(current.Saver || 0),
      Number(current.Main || 0),
      Number(current.Flex || 0),
      currentTotal,
      event.name === 'Saver' ? 1 : 0,
      event.name === 'Main' ? 1 : 0,
      event.name === 'Flex' ? 1 : 0,
    ];
  }

  function predictProbability(features) {
    if (!model) return 0;
    let values = features.map((value, i) => {
      const mean = Number(model.scaler.mean[i] || 0);
      const scale = Number(model.scaler.scale[i] || 1) || 1;
      return (Number(value) - mean) / scale;
    });

    model.layers.forEach((layer, layerIndex) => {
      const output = Array(layer.bias.length).fill(0);
      for (let j = 0; j < output.length; j++) {
        let total = Number(layer.bias[j] || 0);
        for (let i = 0; i < values.length; i++) {
          total += Number(values[i]) * Number(layer.weights[i][j] || 0);
        }
        const isLast = layerIndex === model.layers.length - 1;
        output[j] = isLast ? sigmoid(total) : Math.max(0, total);
      }
      values = output;
    });

    return Number(values[0] || 0);
  }

  function accept(scenario, event, remaining, period) {
    if (!model || remaining <= 0 || event.partySize > remaining) return false;
    const p = predictProbability(featureVector(scenario, event, remaining, period));
    return p >= Number(model.threshold ?? 0.5);
  }

  function summarize(rows, oracleAverageRevenue) {
    const n = Math.max(rows.length, 1);
    const sum = key => rows.reduce(
      (total, row) => total + Number(row[key] || 0),
      0
    );
    const totalAccepted = sum('accepted');
    const totalGross = sum('grossRevenue');
    const revenues = rows.map(row => row.revenue);
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

  function augmentExperiment(result) {
    if (!model) return result;

    const scenario = result.scenario;
    const assumptions = result.assumptions;
    const count = result.replications;
    const baseSeed = result.seed >>> 0;
    const rows = [];
    let representative = null;

    for (let rep = 0; rep < count; rep++) {
      const repSeed = (baseSeed + Math.imul(rep, 0x9e3779b9)) >>> 0;
      const events = SIM.generateStream(scenario, repSeed, assumptions);
      const capture = rep === 0;
      const run = SIM.runPolicy(
        events,
        scenario,
        (event, remaining, period) => accept(
          scenario,
          event,
          remaining,
          period
        ),
        capture,
        assumptions
      );
      rows.push(run);
      if (capture) representative = run;
    }

    result.summaries.nn = summarize(
      rows,
      result.summaries.clairvoyant.averageRevenue
    );
    result.representative.nn = representative;
    result.neural = {
      modelType: model.modelType,
      metrics: model.metrics || {},
      informationBoundary: model.informationBoundary || '',
    };
    return result;
  }

  function installExperimentWrapper() {
    if (wrapped || !model) return;
    originalRunExperiment = SIM.runExperiment.bind(SIM);
    SIM.runExperiment = options => augmentExperiment(originalRunExperiment(options));
    wrapped = true;
  }

  async function loadModel(url = 'data/nn_policy.json') {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return false;
      model = validateModel(await response.json());
      installExperimentWrapper();
      return true;
    } catch (error) {
      console.info('Neural policy is unavailable:', error.message);
      model = null;
      return false;
    }
  }

  function patchPolicyLabel() {
    if (typeof window.policyLabel !== 'function' || window.policyLabel.__nnPatched) return;
    const original = window.policyLabel;
    const patched = key => key === 'nn' ? 'Neural Network' : original(key);
    patched.__nnPatched = true;
    window.policyLabel = patched;
  }

  function patchRepresentativeRenderer() {
    if (typeof window.renderRepresentative !== 'function') return;
    window.renderRepresentative = result => {
      const policies = window.selectedPolicies();
      const histories = Object.fromEntries(
        policies.map(key => [key, result.representative[key].history || []])
      );
      const allRevenue = Object.values(histories)
        .flatMap(rows => rows.map(row => row.revenue));
      const minRevenue = Math.min(0, ...allRevenue);
      const maxRevenue = Math.max(1, ...allRevenue);
      const W = 900, H = 330, L = 72, R = 34, T = 58, B = 56;
      const x = row => L + (SIM.DAYS - row.day) / SIM.DAYS * (W - L - R);
      const y = value => H - B - (value - minRevenue) / Math.max(maxRevenue - minRevenue, 1) * (H - T - B);
      const lineStyle = {
        open: ['#52606d', '0'],
        emsr: ['#1f7a8c', '0'],
        dp: ['#c7922b', '0'],
        nn: ['#6d4c8f', '0'],
      };

      let html = '';
      const legendItems = policies.map(key => ({
        key,
        label: window.policyLabel(key),
        width: window.policyLabel(key).length * 6.5 + 32,
      }));
      const legendWidth = legendItems.reduce((sum, item) => sum + item.width, 0) + 16;
      const legendX = Math.max(L, W - R - legendWidth);

      html += `<g aria-label="Policy legend"><rect class="svg-legend-bg" x="${legendX}" y="10" width="${legendWidth}" height="32" rx="8"></rect>`;
      let itemX = legendX + 10;
      legendItems.forEach(item => {
        const [stroke] = lineStyle[item.key];
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
        const [stroke, dash] = lineStyle[key];
        const finalRevenue = rows[rows.length - 1].revenue;
        html += `<polyline points="${rows.map(row => `${x(row)},${y(row.revenue)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"><title>${window.policyLabel(key)} · final net revenue ${money.format(finalRevenue)}</title></polyline>`;
      });

      document.getElementById('optimizerRepresentative').innerHTML = html;
    };
  }

  function insertPolicyControl(available) {
    if (document.querySelector('[data-policy="nn"]')) return;
    const dpInput = document.querySelector('[data-policy="dp"]');
    const dpLabel = dpInput?.closest('label');
    if (!dpLabel) return;

    const label = document.createElement('label');
    label.className = 'policy-check';
    const metric = model?.metrics?.holdoutBalancedAccuracy;
    const metricText = Number.isFinite(Number(metric))
      ? ` Holdout balanced accuracy: ${(100 * Number(metric)).toFixed(1)}%.`
      : '';
    label.innerHTML = available
      ? `<input type="checkbox" data-policy="nn" checked /><span><strong>Neural Network</strong><small>Locally trained to imitate forecast-DP decisions using only booking-time state and baseline forecast features.${metricText}</small></span>`
      : '<input type="checkbox" data-policy="nn" disabled /><span><strong>Neural Network</strong><small>Train it locally with <code>python neural_network/train_policy.py</code> to create <code>site/data/nn_policy.json</code>.</small></span>';
    dpLabel.insertAdjacentElement('afterend', label);

    const input = label.querySelector('input');
    if (available) {
      input.addEventListener('change', () => {
        if (typeof window.runOptimization === 'function') window.runOptimization();
      });
    }
  }

  async function bootstrap() {
    patchPolicyLabel();
    patchRepresentativeRenderer();
    const available = await loadModel();
    insertPolicyControl(available);

    if (
      available
      && typeof window.runOptimization === 'function'
      && document.getElementById('bestPolicyName')?.textContent !== '—'
    ) {
      window.runOptimization();
    }
  }

  window.AeroYieldNeuralPolicy = {
    EXPECTED_FEATURES,
    loadModel,
    available: () => Boolean(model),
    metadata: () => model,
    featureVector,
    predictProbability,
    bootstrap,
  };

  bootstrap().catch(error => console.error('Could not initialize neural policy:', error));
})();
