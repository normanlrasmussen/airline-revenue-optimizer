# AeroYield neural policy

This folder trains a small neural network to make the same **accept / reject** seat-control decision as AeroYield's finite-horizon dynamic program, while only using information available at booking time.

## Information boundary

The network may use:

- booking progress / time remaining;
- remaining booking capacity;
- current party size;
- the currently offered fare and fare class;
- baseline Saver / Main / Flex fares;
- baseline Saver / Main / Flex expected demand;
- the baseline forecast request probabilities for the current booking period.

It does **not** receive:

- future realized booking requests;
- the realized market-demand shock;
- future cancellations;
- future no-shows;
- the realized future arrival probabilities;
- oracle outcomes.

The labels are generated from the existing finite-horizon DP. That makes the neural network a **policy-distillation** model: it learns to approximate the forecast DP on many states drawn from DB1C-derived AeroYield routes. It is not trained on proprietary airline booking decisions, and it should not be described that way.

## Train locally

From the repository root:

```bash
pip install -r requirements.txt
python neural_network/train_policy.py
```

The script prints holdout metrics and opens a matplotlib loss curve. It also saves:

```text
neural_network/training_loss.png
neural_network/training_metrics.json
site/data/nn_policy.json
```

`site/data/nn_policy.json` is the deployable browser model. After training, serve the site normally:

```bash
python -m http.server 8000 --directory site
```

Then open `http://localhost:8000/optimizer.html`. AeroYield will detect the model and enable the **Neural Network** policy automatically.

To train without opening the matplotlib window:

```bash
python neural_network/train_policy.py --no-show-plot
```

Useful tuning options:

```bash
python neural_network/train_policy.py \
  --samples-per-route 2000 \
  --hidden 64 32 \
  --epochs 400 \
  --learning-rate 0.001
```

## Validation design

Routes are split before state sampling, so the reported test metrics are calculated on held-out routes rather than random rows from routes the model already saw. The default training set is balanced between DP accept and reject examples so the model cannot obtain a misleadingly high score by learning only the majority action.

The loss plot is the first convergence diagnostic. Also check the route-held-out accuracy, balanced accuracy, and log loss in `training_metrics.json` before committing a model for the website.
