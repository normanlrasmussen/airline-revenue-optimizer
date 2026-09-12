from pathlib import Path

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
EXPECTED_NAV = ["Home", "The Problem", "Market Data", "Booking Simulator", "Revenue Optimizer"]


def html(name: str) -> BeautifulSoup:
    return BeautifulSoup((SITE / name).read_text(encoding="utf-8"), "html.parser")


def test_primary_navigation_is_consistent():
    for path in SITE.glob("*.html"):
        soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
        nav = soup.find("nav", attrs={"aria-label": "Primary navigation"})
        assert nav is not None, path.name
        labels = [a.get_text(" ", strip=True) for a in nav.find_all("a")]
        assert labels == EXPECTED_NAV, path.name


def test_local_stylesheets_and_scripts_exist():
    for path in SITE.glob("*.html"):
        soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
        for link in soup.find_all("link", href=True):
            href = link["href"]
            if "://" not in href and not href.startswith("#"):
                assert (SITE / href).exists(), f"{path.name}: missing {href}"
        for script in soup.find_all("script", src=True):
            src = script["src"]
            if "://" not in src:
                assert (SITE / src).exists(), f"{path.name}: missing {src}"


def test_optimizer_has_required_controls_and_engine_scripts():
    soup = html("optimizer.html")
    required_ids = {
        "routeSelect",
        "capacityInput",
        "replicationsInput",
        "demandScale",
        "seedInput",
        "optimizeButton",
        "optimizerPolicyTable",
        "optimizerDistribution",
        "optimizerRepresentative",
    }
    assert required_ids <= {tag.get("id") for tag in soup.find_all(id=True)}
    scripts = [tag["src"] for tag in soup.find_all("script", src=True)]
    assert scripts[-3:] == ["rm.js", "simulation.js", "app.js"]


def test_simulator_uses_shared_policy_and_simulation_engines():
    soup = html("twin.html")
    scripts = [tag["src"] for tag in soup.find_all("script", src=True)]
    assert "rm.js" in scripts
    assert "simulation.js" in scripts
    assert scripts[-1] == "twin.js"


def test_user_facing_pages_no_longer_call_simulator_a_digital_twin():
    for name in ["index.html", "market.html", "data.html", "route.html", "optimizer.html", "twin.html"]:
        text = (SITE / name).read_text(encoding="utf-8").lower()
        assert "digital twin" not in text, name
