(() => {
  const DEFAULT_ON_POLICIES = new Set(['emsr', 'dp', 'nn', 'lp', 'bayes', 'dro']);
  let rerunTimer = null;

  function updatePolicyCopy() {
    const policyHeading = [...document.querySelectorAll('.optimizer-sidebar .policy-label')]
      .find(node => node.textContent.trim() === 'Core policies');
    if (policyHeading) policyHeading.textContent = 'Seat-control policies';

    const note = [...document.querySelectorAll('.optimizer-sidebar .fine-print')]
      .find(node => node.textContent.includes('Start with these three'));
    if (note) {
      note.textContent = 'All available policies are enabled by default so the experiment compares the full method set. Uncheck any policy to isolate a smaller comparison.';
    }

    const heroLead = document.querySelector('.page-hero .lead');
    if (heroLead && heroLead.textContent.includes('optional LP, Bayesian, robust, and neural policies')) {
      heroLead.textContent = 'Choose a route and operating assumptions, then compare seat-control policies on the same uncertain booking streams. AeroYield evaluates Open Sales, EMSR-b, finite-horizon dynamic programming, deterministic LP bid prices, Bayesian adaptive DP, distributionally robust DP, and a trained neural policy. No deployable policy sees the realized future. Only the oracle benchmark does.';
    }
  }

  function applyPolicyDefaults() {
    let changed = false;

    document.querySelectorAll('[data-policy]').forEach(input => {
      if (!DEFAULT_ON_POLICIES.has(input.dataset.policy)) return;
      if (input.disabled || input.dataset.defaultOnApplied === 'true') return;

      input.dataset.defaultOnApplied = 'true';
      if (!input.checked) {
        input.checked = true;
        changed = true;
      }
    });

    updatePolicyCopy();

    if (changed && typeof window.runOptimization === 'function') {
      clearTimeout(rerunTimer);
      rerunTimer = setTimeout(() => window.runOptimization(), 0);
    }
  }

  window.addEventListener('load', () => {
    const sidebar = document.querySelector('.optimizer-sidebar');
    if (!sidebar) return;

    const observer = new MutationObserver(applyPolicyDefaults);
    observer.observe(sidebar, { childList: true, subtree: true });
    applyPolicyDefaults();
  });
})();
