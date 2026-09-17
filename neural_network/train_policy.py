#!/usr/bin/env python3
"""Train a browser-deployable neural-network seat-control policy for AeroYield.

The network is trained by policy distillation: the existing finite-horizon DP
provides accept/reject labels, while the model only receives information that
is available at booking time. No realized future demand, future cancellations,
future no-shows, or future booking arrivals are included as features.

By default the exported model is written directly to ``site/data/nn_policy.json``
so GitHub Pages can use it after you train and commit the generated file.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from optimization.revenue_management import FareDemand, solve_finite_horizon_dp  # noqa: E402
from optimization.simulation import PERIODS, build_probabilities  # noqa: E402


FEATURE_NAMES = [
    "booking_progress",
    "remaining_capacity_fraction",
    "party_size_fraction",
    "request_fare_to_flex",
    "saver_fare_to_flex",
    "main_fare_to_flex",
    "flex_fare_to_flex",
    "saver_demand_per_booking_space",
    "main_demand_per_booking_space",
    "flex_demand_per_booking_space",
    "total_demand_per_booking_space",
    "saver_request_probability_now",
    "main_request_probability_now",
    "flex_request_probability_now",
    "total_request_probability_now",
    "is_saver",
    "is_main",
    "is_flex",
]
CLASS_ORDER = ("Saver", "Main", "Flex")


@dataclass(frozen=True)
class RouteModel:
    route: str
    capacity: int
    booking_limit: int
    classes: tuple[FareDemand, ...]
    probabilities: list[dict[str, float]]
    dp: object


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--markets",
        type=Path,
        default=ROOT / "site/data/market_summary.json",
        help="AeroYield market summary used to build route-specific forecast states.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "site/data/nn_policy.json",
        help="Browser-readable model JSON written after training.",
    )
    parser.add_argument(
        "--loss-plot",
        type=Path,
        default=ROOT / "neural_network/training_loss.png",
        help="PNG path for the training-loss curve.",
    )
    parser.add_argument(
        "--metrics",
        type=Path,
        default=ROOT / "neural_network/training_metrics.json",
        help="JSON path for holdout metrics and the loss history.",
    )
    parser.add_argument("--samples-per-route", type=int, default=1200)
    parser.add_argument("--test-fraction", type=float, default=0.20)
    parser.add_argument("--overbook-pct", type=float, default=5.0)
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--hidden", type=int, nargs="+", default=[48, 24])
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=20260916)
    parser.add_argument(
        "--no-show-plot",
        action="store_true",
        help="Save the loss curve without opening the matplotlib window.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print scikit-learn's per-iteration training output.",
    )
    return parser.parse_args()


def load_markets(path: Path) -> list[dict]:
    markets = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "route",
        "capacity",
        "saverFare",
        "saverDemand",
        "mainFare",
        "mainDemand",
        "flexFare",
        "flexDemand",
    }
    clean = []
    for market in markets:
        if required <= set(market):
            clean.append(market)
    if len(clean) < 5:
        raise ValueError("Need at least five complete route records to train and hold out routes.")
    return clean


def route_classes(market: dict) -> tuple[FareDemand, ...]:
    return (
        FareDemand("Saver", float(market["saverFare"]), float(market["saverDemand"])),
        FareDemand("Main", float(market["mainFare"]), float(market["mainDemand"])),
        FareDemand("Flex", float(market["flexFare"]), float(market["flexDemand"])),
    )


def build_route_model(market: dict, overbook_pct: float) -> RouteModel:
    capacity = max(1, int(market.get("capacity", 180)))
    booking_limit = capacity + round(capacity * np.clip(overbook_pct, 0.0, 30.0) / 100.0)
    classes = route_classes(market)
    probabilities = build_probabilities(classes)
    fares = {fc.name: fc.fare for fc in classes}
    dp = solve_finite_horizon_dp(booking_limit, fares, probabilities)
    return RouteModel(
        route=str(market["route"]),
        capacity=capacity,
        booking_limit=booking_limit,
        classes=classes,
        probabilities=probabilities,
        dp=dp,
    )


def feature_vector(
    route: RouteModel,
    class_name: str,
    period: int,
    remaining: int,
    party_size: int,
) -> list[float]:
    by_name = {fc.name: fc for fc in route.classes}
    flex_fare = max(by_name["Flex"].fare, 1e-9)
    current = route.probabilities[period]
    total_demand = sum(fc.mean_demand for fc in route.classes)
    current_total = sum(float(current.get(name, 0.0)) for name in CLASS_ORDER)

    return [
        period / max(PERIODS - 1, 1),
        remaining / max(route.booking_limit, 1),
        party_size / 4.0,
        by_name[class_name].fare / flex_fare,
        by_name["Saver"].fare / flex_fare,
        by_name["Main"].fare / flex_fare,
        by_name["Flex"].fare / flex_fare,
        by_name["Saver"].mean_demand / max(route.booking_limit, 1),
        by_name["Main"].mean_demand / max(route.booking_limit, 1),
        by_name["Flex"].mean_demand / max(route.booking_limit, 1),
        total_demand / max(route.booking_limit, 1),
        float(current.get("Saver", 0.0)),
        float(current.get("Main", 0.0)),
        float(current.get("Flex", 0.0)),
        current_total,
        1.0 if class_name == "Saver" else 0.0,
        1.0 if class_name == "Main" else 0.0,
        1.0 if class_name == "Flex" else 0.0,
    ]


def dp_group_accept(
    route: RouteModel,
    class_name: str,
    period: int,
    remaining: int,
    party_size: int,
) -> int:
    if remaining <= 0 or party_size > remaining:
        return 0
    by_name = {fc.name: fc for fc in route.classes}
    opportunity_cost = 0.0
    for offset in range(party_size):
        c = max(1, min(route.dp.capacity, remaining - offset))
        opportunity_cost += route.dp.bid_prices[period][c]
    return int(by_name[class_name].fare * party_size + 1e-12 >= opportunity_cost)


def sample_route_states(
    route: RouteModel,
    count: int,
    rng: np.random.Generator,
    *,
    balance: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """Sample DP-labeled states, optionally balancing accept/reject examples."""
    target = max(1, int(count))
    multiplier = 4 if balance else 1
    xs: list[list[float]] = []
    ys: list[int] = []

    for _ in range(target * multiplier):
        period = int(rng.integers(0, PERIODS))
        remaining = int(rng.integers(1, route.booking_limit + 1))
        party_size = int(rng.integers(1, min(4, remaining) + 1))
        class_name = CLASS_ORDER[int(rng.integers(0, len(CLASS_ORDER)))]
        xs.append(feature_vector(route, class_name, period, remaining, party_size))
        ys.append(dp_group_accept(route, class_name, period, remaining, party_size))

    x = np.asarray(xs, dtype=np.float64)
    y = np.asarray(ys, dtype=np.int64)
    if not balance or len(np.unique(y)) < 2:
        return x[:target], y[:target]

    per_class = target // 2
    keep: list[int] = []
    for label in (0, 1):
        indices = np.flatnonzero(y == label)
        rng.shuffle(indices)
        keep.extend(indices[:per_class].tolist())

    if len(keep) < target:
        chosen = set(keep)
        remaining_indices = [i for i in range(len(y)) if i not in chosen]
        rng.shuffle(remaining_indices)
        keep.extend(remaining_indices[: target - len(keep)])

    rng.shuffle(keep)
    selected = np.asarray(keep[:target], dtype=np.int64)
    return x[selected], y[selected]


def build_dataset(
    markets: list[dict],
    samples_per_route: int,
    overbook_pct: float,
    rng: np.random.Generator,
    *,
    balance: bool,
) -> tuple[np.ndarray, np.ndarray]:
    xs = []
    ys = []
    for i, market in enumerate(markets, start=1):
        route = build_route_model(market, overbook_pct)
        x, y = sample_route_states(route, samples_per_route, rng, balance=balance)
        xs.append(x)
        ys.append(y)
        print(
            f"[{i:>3}/{len(markets)}] {route.route}: "
            f"{len(y):,} states, {100 * y.mean():.1f}% accept"
        )
    return np.vstack(xs), np.concatenate(ys)


def export_model(
    path: Path,
    scaler: StandardScaler,
    model: MLPClassifier,
    metrics: dict,
    train_routes: list[str],
    test_routes: list[str],
) -> None:
    payload = {
        "schemaVersion": 1,
        "modelType": "sklearn_mlp_binary_classifier",
        "target": "finite-horizon DP accept/reject decision",
        "informationBoundary": (
            "Uses only booking-time state and the baseline forecast. "
            "No realized future arrivals, future cancellations, future no-shows, "
            "or realized demand shocks are features."
        ),
        "featureNames": FEATURE_NAMES,
        "scaler": {
            "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(),
        },
        "activation": "relu",
        "outputActivation": "logistic",
        "threshold": 0.5,
        "layers": [
            {
                "weights": weights.tolist(),
                "bias": bias.tolist(),
            }
            for weights, bias in zip(model.coefs_, model.intercepts_)
        ],
        "metrics": metrics,
        "training": {
            "trainRoutes": train_routes,
            "testRoutes": test_routes,
            "iterations": int(model.n_iter_),
            "finalLoss": float(model.loss_curve_[-1]),
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    args = parse_args()
    if args.samples_per_route < 10:
        raise ValueError("--samples-per-route must be at least 10")
    if not 0.05 <= args.test_fraction <= 0.50:
        raise ValueError("--test-fraction must be between 0.05 and 0.50")
    if any(width < 1 for width in args.hidden):
        raise ValueError("all hidden-layer widths must be positive")

    rng = np.random.default_rng(args.seed)
    markets = load_markets(args.markets)
    order = rng.permutation(len(markets))
    split = max(1, min(len(markets) - 1, round(len(markets) * (1.0 - args.test_fraction))))
    train_markets = [markets[i] for i in order[:split]]
    test_markets = [markets[i] for i in order[split:]]

    print(f"Routes: {len(train_markets)} train / {len(test_markets)} holdout")
    print("Building DP-labeled training states...")
    x_train, y_train = build_dataset(
        train_markets,
        args.samples_per_route,
        args.overbook_pct,
        rng,
        balance=True,
    )
    print("Building route-held-out test states...")
    x_test, y_test = build_dataset(
        test_markets,
        max(400, args.samples_per_route // 2),
        args.overbook_pct,
        rng,
        balance=False,
    )

    scaler = StandardScaler()
    x_train_scaled = scaler.fit_transform(x_train)
    x_test_scaled = scaler.transform(x_test)

    model = MLPClassifier(
        hidden_layer_sizes=tuple(args.hidden),
        activation="relu",
        solver="adam",
        batch_size=256,
        learning_rate_init=args.learning_rate,
        max_iter=args.epochs,
        early_stopping=True,
        validation_fraction=0.15,
        n_iter_no_change=20,
        random_state=args.seed,
        verbose=args.verbose,
    )

    print(
        f"Training MLP {len(FEATURE_NAMES)} -> "
        f"{' -> '.join(map(str, args.hidden))} -> 1 on {len(y_train):,} states..."
    )
    model.fit(x_train_scaled, y_train)

    probabilities = model.predict_proba(x_test_scaled)[:, 1]
    predictions = (probabilities >= 0.5).astype(np.int64)
    metrics = {
        "holdoutAccuracy": float(accuracy_score(y_test, predictions)),
        "holdoutBalancedAccuracy": float(balanced_accuracy_score(y_test, predictions)),
        "holdoutLogLoss": float(log_loss(y_test, probabilities, labels=[0, 1])),
        "trainExamples": int(len(y_train)),
        "testExamples": int(len(y_test)),
        "trainAcceptRate": float(y_train.mean()),
        "testAcceptRate": float(y_test.mean()),
        "iterations": int(model.n_iter_),
        "finalTrainingLoss": float(model.loss_curve_[-1]),
    }

    export_model(
        args.output,
        scaler,
        model,
        metrics,
        [str(m["route"]) for m in train_markets],
        [str(m["route"]) for m in test_markets],
    )

    args.metrics.parent.mkdir(parents=True, exist_ok=True)
    args.metrics.write_text(
        json.dumps({**metrics, "lossCurve": [float(v) for v in model.loss_curve_]}, indent=2),
        encoding="utf-8",
    )

    args.loss_plot.parent.mkdir(parents=True, exist_ok=True)
    iterations = np.arange(1, len(model.loss_curve_) + 1)
    plt.figure(figsize=(8, 5))
    plt.plot(iterations, model.loss_curve_)
    plt.xlabel("Training iteration")
    plt.ylabel("Log loss")
    plt.title("AeroYield neural policy training loss")
    plt.tight_layout()
    plt.savefig(args.loss_plot, dpi=160)

    print("\nTraining complete")
    print(f"  Holdout accuracy:          {metrics['holdoutAccuracy']:.4f}")
    print(f"  Holdout balanced accuracy: {metrics['holdoutBalancedAccuracy']:.4f}")
    print(f"  Holdout log loss:          {metrics['holdoutLogLoss']:.4f}")
    print(f"  Final training loss:       {metrics['finalTrainingLoss']:.6f}")
    print(f"  Iterations:                {model.n_iter_}/{args.epochs}")
    print(f"  Browser model:             {args.output}")
    print(f"  Loss curve:                {args.loss_plot}")
    print(f"  Metrics:                   {args.metrics}")
    if model.n_iter_ >= args.epochs:
        print("  Note: training reached max_iter; inspect the curve and consider more epochs.")
    else:
        print("  Early stopping triggered before max_iter; inspect the curve for convergence.")

    if not args.no_show_plot:
        plt.show()
    else:
        plt.close()


if __name__ == "__main__":
    main()
