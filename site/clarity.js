(() => {
  const OPTIONAL_POLICIES = new Set(['nn', 'lp', 'bayes', 'dro']);
  let rerunTimer = null;

  function insertAdvancedLabel() {
    if (document.getElementById('advancedPoliciesLabel')) return;

    const firstOptional = [...document.querySelectorAll('[data-policy]')]
      .find(input => OPTIONAL_POLICIES.has(input.dataset.policy));
    const firstLabel = firstOptional?.closest('label');
    if (!firstLabel) return;

    const heading = document.createElement('div');
    heading.id = 'advancedPoliciesLabel';
    heading.className = 'field-label policy-label';
    heading.textContent = 'Advanced / learned policies (optional)';
    firstLabel.insertAdjacentElement('beforebegin', heading);
  }

  function applyPortfolioDefaults() {
    let changed = false;

    document.querySelectorAll('[data-policy]').forEach(input => {
      if (!OPTIONAL_POLICIES.has(input.dataset.policy)) return;
      if (input.dataset.portfolioDefaultApplied === 'true') return;

      input.dataset.portfolioDefaultApplied = 'true';
      if (input.checked) {
        input.checked = false;
        changed = true;
      }
    });

    insertAdvancedLabel();

    if (changed && typeof window.runOptimization === 'function') {
      clearTimeout(rerunTimer);
      rerunTimer = setTimeout(() => window.runOptimization(), 0);
    }
  }

  window.addEventListener('load', () => {
    const sidebar = document.querySelector('.optimizer-sidebar');
    if (!sidebar) return;

    const observer = new MutationObserver(applyPortfolioDefaults);
    observer.observe(sidebar, { childList: true, subtree: true });
    applyPortfolioDefaults();
  });
})();
