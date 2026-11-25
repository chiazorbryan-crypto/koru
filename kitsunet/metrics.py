"""metrics.py - the marks used to judge the taste network. All take the true answers (0/1) and predicted chances."""
import numpy as np


def log_loss(y, p):
    """How wrong the chances are, punishing confident mistakes most. Lower is better."""
    p = np.clip(np.asarray(p, dtype=np.float64), 1e-7, 1 - 1e-7)
    return float(-np.mean(np.where(y == 1, np.log(p), np.log(1 - p))))


def accuracy(y, p):
    return float(np.mean((np.asarray(p) > 0.5) == (y == 1)))


def auc(y, p):
    """Chance that a random series the reader finished and enjoyed is scored above a random one they didn't."""
    p = np.asarray(p, dtype=np.float64)
    order = np.argsort(p, kind="stable")
    sp = p[order]
    edges = np.flatnonzero(np.concatenate(([True], sp[1:] != sp[:-1], [True])))
    avg = (edges[:-1] + edges[1:] + 1) / 2.0
    ranks = np.empty(len(p))
    ranks[order] = np.repeat(avg, np.diff(edges))
    pos = y == 1
    n1, n0 = int(pos.sum()), int((~pos).sum())
    if not n1 or not n0:
        return float("nan")
    return float((ranks[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def per_user_auc(y, p, uid):
    """AUC inside each reader's own list, averaged over readers who have both kinds (how well it ranks for one person)."""
    out = []
    for u in np.unique(uid):
        m = uid == u
        if 0 < y[m].sum() < m.sum():
            out.append(auc(y[m], p[m]))
    return float(np.mean(out)) if out else float("nan")


def calibration(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    which = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    ece, table = 0.0, []
    for b in range(bins):
        m = which == b
        if m.any():
            said, happened, share = float(p[m].mean()), float(y[m].mean()), float(m.mean())
            ece += abs(said - happened) * share
            table.append((round(said, 3), round(happened, 3), round(share, 4)))
    return ece, table
