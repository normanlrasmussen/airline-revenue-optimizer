from pathlib import Path

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
EXPECTED_NAV = ["Home", "The Problem", "Market Data", "Revenue Optimizer"]
PRIMARY_PAGES = ["index.html", "market.html", "data.html", "route.html", "optimizer.html"]


def html(name: str) -> BeautifulSoup:
    return BeautifulSoup((SITE / name).read_text(encoding="utf-8"), "html.parser")


def test_primary_navigation_is_consistent():
    for name in PRIMARY_PAGES:
        path = SITE / name
        soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
        nav = soup.find("nav", attrs={"aria-label": "Primary navigation"})
        assert nav is not None, path.name
        labels = [a.get_text(" ", strip=True) for a in nav.find_all("a")]
        assert labels == EXPECTED_NAV, path.name
        assert all(a.get("href") != "twin.html" for a in nav.find_all("a")), path.name


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


def test_legacy_simulator_url_redirects_to_optimizer():
    soup = html("twin.html")
    refresh = soup.find("meta", attrs={"http-equiv": "refresh"})
    assert refresh is not None
    assert "optimizer.html" in refresh.get("content", "")
    assert soup.find("nav") is None
    assert not (SITE / "twin.js").exists()


def test_user_facing_pages_no_longer_present_booking_simulator_as_a_product():
    for name in PRIMARY_PAGES:
        text = (SITE / name).read_text(encoding="utf-8").lower()
        assert "booking simulator" not in text, name
        assert 'href="twin.html"' not in text, name
        assert "digital twin" not in text, name
