(() => {
  function normalInv(p) {
    if (!(p > 0 && p < 1)) {
      if (p === 0) return -Infinity;
      if (p === 1) return Infinity;
      throw new RangeError('p must be in [0, 1]');
    }
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const plow = 0.02425;
    const phigh = 1 - plow;
    if (p < plow) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > phigh) {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  function sortClasses(classes) {
    if (!Array.isArray(classes) || classes.length === 0) throw new Error('At least one fare class is required.');
    const clean = classes.map(fc => ({
      name: String(fc.name),
      fare: Number(fc.fare),
      meanDemand: Number(fc.meanDemand ?? fc.demand ?? 0),
    }));
    if (clean.some(fc => !Number.isFinite(fc.fare) || !Number.isFinite(fc.meanDemand) || fc.fare < 0 || fc.meanDemand < 0)) throw new Error('Fares and mean demand must be non-negative numbers.');
    return clean.sort((x, y) => y.fare - x.fare);
  }

  function emsrB(capacity, classes) {
    capacity = Math.max(0, Math.floor(Number(capacity)));
    const ordered = sortClasses(classes);
    const protection = { [ordered[0].name]: 0 };
    const bookingLimit = { [ordered[0].name]: capacity };
    let cumulativeMean = 0;
    let cumulativeFareDemand = 0;

    for (let i = 0; i < ordered.length - 1; i++) {
      const higher = ordered[i];
      const lower = ordered[i + 1];
      cumulativeMean += higher.meanDemand;
      cumulativeFareDemand += higher.fare * higher.meanDemand;
      let protect = 0;
      if (cumulativeMean > 0) {
        const weightedHighFare = cumulativeFareDemand / cumulativeMean;
        let critical = weightedHighFare > 0 ? 1 - lower.fare / weightedHighFare : 0;
        critical = Math.min(1 - 1e-9, Math.max(1e-9, critical));
        const raw = cumulativeMean + Math.sqrt(cumulativeMean) * normalInv(critical);
        protect = Math.round(Math.min(capacity, Math.max(0, raw)));
      }
      protection[lower.name] = protect;
      bookingLimit[lower.name] = Math.max(0, capacity - protect);
    }
    return { ordered, protection, bookingLimit };
  }

  function emsrAccept(result, className, remainingCapacity) {
    if (remainingCapacity <= 0) return false;
    if (!(className in result.protection)) throw new Error(`Unknown class ${className}`);
    return remainingCapacity > result.protection[className];
  }

  function buildDP(capacity, classFares, periodProbabilities) {
    capacity = Math.max(0, Math.floor(Number(capacity)));
    const names = Object.keys(classFares);
    if (!names.length) throw new Error('At least one fare is required.');
    const fares = Object.fromEntries(names.map(name => [name, Number(classFares[name])]));
    if (Object.values(fares).some(fare => !Number.isFinite(fare) || fare < 0)) throw new Error('Fares must be non-negative.');
    const T = periodProbabilities.length;
    const values = Array.from({ length: T + 1 }, () => Array(capacity + 1).fill(0));
    const bidPrices = Array.from({ length: T }, () => Array(capacity + 1).fill(0));

    for (let t = T - 1; t >= 0; t--) {
      const probs = periodProbabilities[t];
      const total = Object.values(probs).reduce((sum, p) => sum + Number(p || 0), 0);
      if (total > 1 + 1e-10 || Object.values(probs).some(p => Number(p) < 0)) throw new Error('Per-period request probabilities must be non-negative and sum to at most one.');
      const pNone = Math.max(0, 1 - total);
      for (let c = 0; c <= capacity; c++) {
        const reject = values[t + 1][c];
        let expected = pNone * reject;
        for (const name of names) {
          const p = Number(probs[name] || 0);
          const best = c === 0 ? reject : Math.max(reject, fares[name] + values[t + 1][c - 1]);
          expected += p * best;
        }
        values[t][c] = expected;
        if (c > 0) bidPrices[t][c] = values[t + 1][c] - values[t + 1][c - 1];
      }
    }

    return {
      values,
      bidPrices,
      expectedRevenue: values[0][capacity],
      accept(period, remainingCapacity, fare) {
        if (remainingCapacity <= 0) return false;
        const t = Math.max(0, Math.min(T - 1, Math.floor(period)));
        const c = Math.max(1, Math.min(capacity, Math.floor(remainingCapacity)));
        return Number(fare) + 1e-12 >= bidPrices[t][c];
      },
    };
  }

  function clairvoyant(capacity, events) {
    const sorted = [...events].sort((a, b) => Number(b.fare) - Number(a.fare));
    const accepted = sorted.slice(0, Math.max(0, Math.floor(capacity)));
    return {
      revenue: accepted.reduce((sum, event) => sum + Number(event.fare), 0),
      accepted: accepted.length,
      byClass: accepted.reduce((acc, event) => {
        acc[event.name] = (acc[event.name] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  window.AeroYieldRM = { normalInv, emsrB, emsrAccept, buildDP, clairvoyant };
})();
