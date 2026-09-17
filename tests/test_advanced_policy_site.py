from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


def test_advanced_policy_bundle_is_loaded_after_neural_bundle():
    rm = (SITE / "rm.js").read_text(encoding="utf-8")
    assert "loadScript('neural_policy.js')" in rm
    assert ".then(() => loadScript('advanced_policies.js'))" in rm
    assert (SITE / "advanced_policies.js").exists()


def test_advanced_policy_bundle_exposes_all_three_requested_strategies():
    text = (SITE / "advanced_policies.js").read_text(encoding="utf-8")
    assert "Deterministic LP" in text
    assert "Bayesian Adaptive DP" in text
    assert "Distributionally Robust DP" in text
    assert "Gamma-Poisson" in text
    assert "total-variation" in text
    assert "certainty-equivalent" in text


def test_browser_rm_layer_contains_advanced_policy_math():
    text = (SITE / "rm.js").read_text(encoding="utf-8")
    assert "buildLPBidPricePolicy" in text
    assert "gammaPoissonScale" in text
    assert "scaleProbabilitySchedule" in text
    assert "worstCaseTVExpectation" in text
    assert "buildRobustDP" in text
