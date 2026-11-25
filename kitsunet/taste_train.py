"""
taste_train.py - step 3 of the taste network: train networks and keep the best version of each.

A run learns from the TRAIN readers, is marked on the VALIDATION readers several times per pass,
keeps the weights with the best validation loss and stops once that stops improving.
TEST readers are never touched here (taste_evaluate.py is the final exam).

Stages (results appended to <data>/runs/taste/search.json):
    python kitsunet\\taste_train.py base      logistic regression (no hidden layer): the bar to beat
    python kitsunet\\taste_train.py explore   a few small shapes
    python kitsunet\\taste_train.py groups    the chosen shape with one group of inputs hidden at a time
    python kitsunet\\taste_train.py final     the chosen shape from three random starts
"""
import json
import math
import sys
import time

import numpy as np
import torch
from torch import nn

from common import PREPARED, RUNS
from metrics import auc, log_loss
from taste_features import FEATURES, GROUPS, N_FEATURES

TRUNS = RUNS / "taste"
RESULTS = TRUNS / "search.json"

EXPLORE = [
    # name           hidden         lr     dropout  wd
    ("x-32",         [32],          3e-3,  0.0,     1e-4),
    ("x-64-32",      [64, 32],      3e-3,  0.0,     1e-4),
    ("x-64-32-do",   [64, 32],      3e-3,  0.1,     1e-4),
    ("x-128-64",     [128, 64],     2e-3,  0.1,     1e-4),
    ("x-128-64-32",  [128, 64, 32], 2e-3,  0.1,     1e-4),
]

_cache = {}


def load_split(name):
    if name not in _cache:
        X = np.load(PREPARED / f"{name}_X.npy")
        y = np.load(PREPARED / f"{name}_y.npy")
        view = np.load(PREPARED / f"{name}_view.npy")
        uid = np.load(PREPARED / f"{name}_uid.npy")
        _cache[name] = (torch.from_numpy(X), torch.from_numpy(y.astype(np.float32)), view, uid)
    return _cache[name]


def feature_scale():
    path = PREPARED / "scale.json"
    if path.exists():
        s = json.loads(path.read_text())
        return np.array(s["mean"], dtype=np.float32), np.array(s["std"], dtype=np.float32)
    X = np.load(PREPARED / "train_X.npy").astype(np.float64)
    mean, std = X.mean(0), X.std(0)
    std = np.where(std < 1e-6, 1.0, std)
    path.write_text(json.dumps({"features": FEATURES, "mean": mean.tolist(), "std": std.tolist()}, indent=1))
    return mean.astype(np.float32), std.astype(np.float32)


class TasteNet(nn.Module):
    """Inputs -> scale -> hidden layers with ReLU -> one output (before the sigmoid)."""

    def __init__(self, hidden, dropout, mean, std):
        super().__init__()
        self.register_buffer("mean", torch.tensor(mean))
        self.register_buffer("std", torch.tensor(std))
        layers, width = [], N_FEATURES
        for h in hidden:
            layers += [nn.Linear(width, h), nn.ReLU()]
            if dropout > 0:
                layers.append(nn.Dropout(dropout))
            width = h
        layers.append(nn.Linear(width, 1))
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        return self.net((x - self.mean) / self.std).squeeze(1)


@torch.no_grad()
def predict(model, X, batch=131072):
    model.eval()
    return torch.cat([torch.sigmoid(model(X[i:i + batch])) for i in range(0, len(X), batch)]).numpy()


def train_model(name, hidden, lr=3e-3, weight_decay=1e-4, dropout=0.0, batch=1024, epochs=8, seed=0,
                evals_per_epoch=4, patience=8, blank=(), log=print):
    torch.manual_seed(seed)
    Xtr, ytr, _, _ = load_split("train")
    Xva, yva, _, _ = load_split("val")
    yva_np = yva.numpy()
    mean, std = feature_scale()
    model = TasteNet(hidden, dropout, mean, std)
    if blank:
        with torch.no_grad():
            model.std[[FEATURES.index(b) for b in blank]] = 1e9
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    loss_fn = nn.BCEWithLogitsLoss()
    n = len(ytr)
    spe = n // batch
    total = spe * epochs
    warm = max(1, int(total * 0.03))
    sched = lambda s: (s + 1) / warm if s < warm else 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, total - warm)))
    every = max(1, spe // evals_per_epoch)
    run = TRUNS / name
    run.mkdir(parents=True, exist_ok=True)
    params = sum(p.numel() for p in model.parameters())
    log(f"[{name}] hidden={hidden} lr={lr} wd={weight_decay} dropout={dropout} rows={n:,} params={params:,}")
    best, bad, step, t0, stop = {"val_loss": 1e9}, 0, 0, time.time(), False
    for ep in range(epochs):
        order = torch.randperm(n)
        model.train()
        for b in range(spe):
            idx = order[b * batch:(b + 1) * batch]
            for g in opt.param_groups:
                g["lr"] = lr * sched(step)
            loss = loss_fn(model(Xtr[idx]), ytr[idx])
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            step += 1
            if step % every == 0 or step == total:
                p = predict(model, Xva)
                vl, va = log_loss(yva_np, p), auc(yva_np, p)
                better = vl < best["val_loss"] - 1e-5
                log(f"[{name}] epoch {step / spe:.2f} val_loss {vl:.4f} val_auc {va:.4f} {'*' if better else ''}")
                if better:
                    best, bad = {"val_loss": vl, "val_auc": va, "step": step}, 0
                    torch.save(model.state_dict(), run / "best.pt")
                else:
                    bad += 1
                    if bad >= patience:
                        stop = True
                        break
                model.train()
        if stop:
            break
    result = {"name": name, "hidden": list(hidden), "lr": lr, "weight_decay": weight_decay, "dropout": dropout,
              "params": params, "seed": seed, "blank": list(blank), "minutes": (time.time() - t0) / 60, **best}
    (run / "result.json").write_text(json.dumps(result, indent=1))
    log(f"[{name}] best val_loss {best['val_loss']:.4f} val_auc {best.get('val_auc', 0):.4f} ({result['minutes']:.1f} min)")
    return result


def load_model(name):
    r = json.loads((TRUNS / name / "result.json").read_text())
    mean, std = feature_scale()
    m = TasteNet(r["hidden"], r["dropout"], mean, std)          # same layer numbering; eval() turns dropout off
    m.load_state_dict(torch.load(TRUNS / name / "best.pt"))
    m.eval()
    return m, r


def load():
    return json.loads(RESULTS.read_text()) if RESULTS.exists() else []


def save(r, stage):
    rs = [x for x in load() if x["name"] != r["name"]] + [{**r, "stage": stage}]
    RESULTS.write_text(json.dumps(rs, indent=1))


def log(line):
    print(line, flush=True)
    with open(TRUNS / "search.log", "a") as f:
        f.write(line + "\n")


def table(stage):
    rows = sorted((r for r in load() if r["stage"] == stage), key=lambda r: r["val_loss"])
    log(f"\n--- {stage}: best first ---")
    for r in rows:
        log(f"  {r['name']:16} val_loss {r['val_loss']:.4f}  val_auc {r['val_auc']:.4f}  params {r['params']:>6,}  {r['minutes']:.1f} min")
    return rows


def chosen():
    """The smallest explored network within 0.001 of the best validation loss."""
    rows = [r for r in load() if r["stage"] == "explore"]
    best = min(r["val_loss"] for r in rows)
    return min((r for r in rows if r["val_loss"] <= best + 0.001), key=lambda r: r["params"])


def main(stage):
    TRUNS.mkdir(parents=True, exist_ok=True)
    done = {r["name"] for r in load()}
    if stage == "base":
        if "logreg" not in done:
            save(train_model("logreg", [], lr=1e-2, weight_decay=0.0, log=log), "base")
    elif stage == "explore":
        for name, hidden, lr, do, wd in EXPLORE:
            if name not in done:
                save(train_model(name, hidden, lr=lr, dropout=do, weight_decay=wd, log=log), "explore")
        log(f"chosen: {chosen()['name']}")
    elif stage == "groups":
        c = chosen()
        for g, names in GROUPS.items():
            name = "no-" + g
            if name not in done:
                save(train_model(name, c["hidden"], lr=c["lr"], dropout=c["dropout"], weight_decay=c["weight_decay"],
                                 epochs=6, blank=names, log=log), "groups")
    elif stage == "final":
        c = chosen()
        for seed in (0, 1):
            name = f"final-{'-'.join(map(str, c['hidden']))}-s{seed}"
            if name not in done:
                save(train_model(name, c["hidden"], lr=c["lr"], dropout=c["dropout"], weight_decay=c["weight_decay"],
                                 epochs=12, seed=seed, log=log), "final")
    table(stage)


if __name__ == "__main__":
    main(sys.argv[1])
