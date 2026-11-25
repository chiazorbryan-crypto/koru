"""
taste_evaluate.py - step 4 of the taste network: the final exam, on the TEST readers (never used before).

Compares the network with the bars to beat on each view (full AniList metadata / Koru-like metadata /
small fresh-start profiles):
  - always "yes"                   (the share of positives)
  - your own hit rate              (u_pos: how often this reader finishes and enjoys what they start)
  - the series's AniList score     (full view only; not something Koru usually has)
  - logistic regression on the same inputs
and writes runs/taste/<name>/report.json.

Run:   python kitsunet\\taste_evaluate.py final-64-32-s0
"""
import json
import sys

import numpy as np

from metrics import accuracy, auc, calibration, log_loss, per_user_auc
from taste_features import FEATURES
from taste_train import TRUNS, load_model, load_split, predict

VIEWS = ["full", "koru", "small"]


def marks(y, p, uid):
    return {"rows": int(len(y)), "readers": int(len(np.unique(uid))), "auc": auc(y, p), "accuracy": accuracy(y, p),
            "log_loss": log_loss(y, p), "per_reader_auc": per_user_auc(y, p, uid), "ece": calibration(y, p)[0]}


def main(name, split="test"):
    X, y, view, uid = load_split(split)
    y = y.numpy().astype(np.int64)
    model, result = load_model(name)
    base, _ = load_model("logreg")
    p_net, p_lr = predict(model, X), predict(base, X)
    Xn = X.numpy()
    u_pos = Xn[:, FEATURES.index("u_pos")]
    s_avg = Xn[:, FEATURES.index("s_avg")]
    report = {"run": name, "split": split, "views": {}}
    for v, vname in enumerate(VIEWS):
        m = view == v
        if not m.any():
            continue
        r = {"network": marks(y[m], p_net[m], uid[m]), "logreg": marks(y[m], p_lr[m], uid[m]),
             "your_hit_rate": marks(y[m], u_pos[m], uid[m]),
             "always_yes": {"accuracy": float(y[m].mean()), "auc": 0.5}}
        if vname == "full":
            has = Xn[m, FEATURES.index("s_has_avg")] > 0
            r["anilist_score"] = {"auc": auc(y[m][has], s_avg[m][has]), "rows": int(has.sum())}
            for c in ("s_kr", "s_jp", "s_cn"):
                cm = Xn[m, FEATURES.index(c)] > 0
                r["network_" + c[2:]] = marks(y[m][cm], p_net[m][cm], uid[m][cm])
        r["calibration"] = calibration(y[m], p_net[m])[1]
        report["views"][vname] = r
    (TRUNS / name / f"report_{split}.json").write_text(json.dumps(report, indent=1))
    print(f"{name} on {split} readers")
    for vname, r in report["views"].items():
        n, l, h = r["network"], r["logreg"], r["your_hit_rate"]
        print(f"  {vname:5}: rows {n['rows']:>7,}  network AUC {n['auc']:.4f} acc {n['accuracy'] * 100:.1f}% (per-reader AUC {n['per_reader_auc']:.3f}, ECE {n['ece']:.3f})"
              f" | logreg AUC {l['auc']:.4f} acc {l['accuracy'] * 100:.1f}% | hit rate AUC {h['auc']:.4f} | always-yes acc {r['always_yes']['accuracy'] * 100:.1f}%"
              + (f" | AniList score AUC {r['anilist_score']['auc']:.4f}" if "anilist_score" in r else ""))
        if vname == "full":
            for c in ("kr", "jp", "cn"):
                x = r["network_" + c]
                print(f"         {c}: rows {x['rows']:,} AUC {x['auc']:.4f} acc {x['accuracy'] * 100:.1f}%")
    return report


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "test")
