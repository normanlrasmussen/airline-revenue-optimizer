(() => {
  const chart = document.getElementById('networkFareTrend');
  if (!chart) return;

  const solidifyObservedFare = () => {
    chart.querySelectorAll('polyline[stroke="#52606d"]').forEach(line => {
      line.removeAttribute('stroke-dasharray');
    });
  };

  new MutationObserver(solidifyObservedFare).observe(chart, {
    childList: true,
    subtree: true,
  });
  solidifyObservedFare();
})();
