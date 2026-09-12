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


def test_optimizer_explains_each_policy_in_plain_language():
    text = (SITE / "optimizer.html").read_text(encoding="utf-8")
    assert "Accepts every request while a seat remains" in text
    assert "Protects seats for expected higher-fare demand" in text
    assert "Accepts a request only when its fare is at least the expected future value of the seat" in text
    assert "Clairvoyant benchmark:" in text
    assert "unattainable upper bound" in text


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


def test_simplified_portfolio_sections_stay_removed():
    index_text = (SITE / "index.html").read_text(encoding="utf-8").lower()
    data_text = (SITE / "data.html").read_text(encoding="utf-8").lower()
    route_text = (SITE / "route.html").read_text(encoding="utf-8").lower()

    assert "decision pipeline" not in index_text
    assert "where to investigate" not in data_text
    assert "opportunity score" not in data_text
    assert "decision context" not in route_text
    assert "opportunity score" not in route_text


def test_opportunity_score_logic_is_removed_from_browser_code():
    for name in ["analytics.js", "data.js", "route.js", "app.js"]:
        text = (SITE / name).read_text(encoding="utf-8")
        assert "opportunityScore" not in text, name
        assert "Opportunity score" not in text, name


def test_market_data_explains_db1c_summary_badge():
    text = (SITE / "data.html").read_text(encoding="utf-8").lower()
    assert "db1c-derived market summary" in text
    assert "up to 11 months" in text
    assert "not live airline booking data" in text
    assert "some routes can have fewer months of coverage" in text


def test_core_booking_decision_is_visually_emphasized():
    soup = html("market.html")
    decision = soup.select_one(".decision-callout")
    assert decision is not None
    assert "Accept this booking now" in decision.get_text(" ", strip=True)
    assert "protect the seat" in decision.get_text(" ", strip=True)


def test_network_trend_contains_stacked_fare_class_views():
    soup = html("data.html")
    required_ids = {
        "networkPassengerTrend",
        "networkFareTrend",
        "networkClassTicketTrend",
        "networkRevenueShareTrend",
    }
    assert required_ids <= {tag.get("id") for tag in soup.find_all(id=True)}
    text = soup.get_text(" ", strip=True)
    assert "Fare classes and average yield by month" in text
    assert "Estimated tickets by modeled fare class" in text
    assert "Estimated revenue share by modeled fare class" in text
    assert "DB1C does not report Saver/Main/Flex booking classes" in text


def test_cumulative_revenue_chart_uses_legend_not_end_labels():
    text = (SITE / "app.js").read_text(encoding="utf-8")
    assert 'aria-label="Policy legend"' in text
    assert "svg-legend-bg" in text
    assert "final revenue" in text
    assert "opportunityScore" not in text
