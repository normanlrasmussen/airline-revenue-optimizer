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


def test_all_available_optimizer_policies_default_on():
    clarity = (SITE / "clarity.js").read_text(encoding="utf-8")
    neural = (SITE / "neural_policy.js").read_text(encoding="utf-8")
    advanced = (SITE / "advanced_policies.js").read_text(encoding="utf-8")

    assert "DEFAULT_ON_POLICIES" in clarity
    for key in ("emsr", "dp", "nn", "lp", "bayes", "dro"):
        assert f"'{key}'" in clarity

    assert 'data-policy="nn" checked' in neural
    assert 'data-policy="${spec.key}" checked' in advanced
    assert "Advanced / learned policies (optional)" not in clarity
