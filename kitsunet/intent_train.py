"""
intent_train.py - steps 2 to 4 of the intent network: search, final exam, export.

The network (fastText style, tiny on purpose):
    message -> pieces (textfeat.py) -> hashed rows of an embedding table -> average
            -> [optional hidden layer with ReLU] -> one score per intent -> softmax

Stages:
    python kitsunet\\intent_train.py base      a bag of words + softmax (no letter runs), the bar to beat
    python kitsunet\\intent_train.py search    a few table sizes and shapes, judged on validation
    python kitsunet\\intent_train.py exam      the chosen network on the hand-written messages (once, at the end)
    python kitsunet\\intent_train.py export    writes web/kitsunet/intent.json and its part of golden.json

Validation = examples held back before augmenting (plus variations of only those), so it
measures messages the network never saw. The final exam is kitsunet/intent_exam.jsonl:
messages written by hand for this, never augmented, never trained on (see exam() for the
earlier set, intent_heldout.jsonl).
"""
import base64
import json
import math
import sys
import time

import numpy as np
import torch
from torch import nn

import textfeat as T
from common import DATA, HERE, RUNS, WEB_OUT

IDATA = DATA / "intent"
IRUNS = RUNS / "intent"
RESULTS = IRUNS / "search.json"
MAX_BYTES = 1_500_000

SEARCH = [
    # name                 buckets  dim  hidden  dropout  keep  smooth     (keep: share of pieces kept per step)
    ("i-8k-32",             8192,   32,  0,      0.0,     1.0,  0.0),
    ("i-8k-32-pd",          8192,   32,  0,      0.0,     0.75, 0.0),
    ("i-8k-32-pd-ls",       8192,   32,  0,      0.0,     0.75, 0.1),
    ("i-16k-32-pd-ls",     16384,   32,  0,      0.0,     0.75, 0.1),
    ("i-8k-48-pd-ls",       8192,   48,  0,      0.0,     0.75, 0.1),
    ("i-8k-32-h64-pd-ls",   8192,   32,  64,     0.1,     0.75, 0.1),
]


def read(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def words_only(text, buckets):
    """For the baseline: whole words only, no letter runs and no pairs."""
    return [T.fnv1a("w:" + w) % buckets for w in T.tidy(text)]


def encode(rows, buckets, labels, fn=None):
    fn = fn or (lambda t: T.ids(t, buckets))
    flat, offsets = [], []
    for r in rows:
        offsets.append(len(flat))
        flat += fn(r["text"])
    y = torch.tensor([labels.index(r["intent"]) for r in rows])
    return torch.tensor(flat, dtype=torch.long), torch.tensor(offsets, dtype=torch.long), y


class IntentNet(nn.Module):
    def __init__(self, buckets, dim, hidden, n_out, dropout):
        super().__init__()
        self.emb = nn.EmbeddingBag(buckets, dim, mode="mean")
        nn.init.zeros_(self.emb.weight)              # rows no message used stay at zero (no noise in the app)
        layers = []
        width = dim
        if hidden:
            layers += [nn.Linear(dim, hidden), nn.ReLU()]
            width = hidden
        self.drop = nn.Dropout(dropout)
        layers.append(nn.Linear(width, n_out))
        self.head = nn.Sequential(*layers)

    def forward(self, flat, offsets):
        return self.head(self.drop(self.emb(flat, offsets)))


def batches(n, size, rng):
    order = rng.permutation(n)
    for i in range(0, n, size):
        yield order[i:i + size]


def subset(flat, offsets, idx, keep=1.0, rng=None):
    """The pieces of some messages; with keep < 1 each piece is dropped at random (at least one stays)."""
    ends = torch.cat([offsets[1:], torch.tensor([len(flat)])])
    parts, offs, at = [], [], 0
    for i in idx.tolist():
        a, b = int(offsets[i]), int(ends[i])
        part = flat[a:b]
        if keep < 1.0 and b - a > 1:
            m = torch.from_numpy(rng.random(b - a) < keep)
            if m.any():
                part = part[m]
        parts.append(part)
        b = a + len(part)
        offs.append(at)
        at += b - a
    return (torch.cat(parts) if parts else torch.zeros(0, dtype=torch.long)), torch.tensor(offs, dtype=torch.long)


@torch.no_grad()
def probs(model, flat, offsets):
    model.eval()
    return torch.softmax(model(flat, offsets), dim=1).numpy()


def train(name, buckets, dim, hidden, dropout, words=False, epochs=30, lr=5e-3, wd=1e-6, batch=64, seed=0, log=print,
          keep=1.0, smooth=0.0):
    """keep: share of a message's pieces kept in each training step. smooth: label smoothing."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    meta = json.loads((IDATA / "meta.json").read_text())
    labels = meta["intents"]
    fn = (lambda t: words_only(t, buckets)) if words else None
    tr, va = read(IDATA / "train.jsonl"), read(IDATA / "val.jsonl")
    Xf, Xo, y = encode(tr, buckets, labels, fn)
    Vf, Vo, vy = encode(va, buckets, labels, fn)
    model = IntentNet(buckets, dim, hidden, len(labels), dropout)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=wd)
    loss_fn = nn.CrossEntropyLoss(label_smoothing=smooth)
    steps = epochs * math.ceil(len(y) / batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.1)
    best, bad, t0 = {"val_loss": 1e9}, 0, time.time()
    (IRUNS / name).mkdir(parents=True, exist_ok=True)
    for ep in range(epochs):
        model.train()
        tot = 0.0
        for idx in batches(len(y), batch, rng):
            f, o = subset(Xf, Xo, torch.from_numpy(idx), keep, rng)
            loss = loss_fn(model(f, o), y[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(idx)
        p = probs(model, Vf, Vo)
        vl = float(-np.mean(np.log(np.clip(p[np.arange(len(vy)), vy.numpy()], 1e-9, 1))))
        acc = float(np.mean(p.argmax(1) == vy.numpy()))
        star = vl < best["val_loss"] - 1e-4
        log(f"[{name}] epoch {ep + 1} train {tot / len(y):.4f} val_loss {vl:.4f} val_acc {acc:.4f} {'*' if star else ''}")
        if star:
            best, bad = {"val_loss": vl, "val_acc": acc, "epoch": ep + 1}, 0
            torch.save(model.state_dict(), IRUNS / name / "best.pt")
        else:
            bad += 1
            if bad >= 5:
                break
    params = sum(p.numel() for p in model.parameters())
    result = {"name": name, "buckets": buckets, "dim": dim, "hidden": hidden, "dropout": dropout, "words_only": words,
              "keep": keep, "label_smoothing": smooth,
              "params": params, "minutes": (time.time() - t0) / 60, **best}
    (IRUNS / name / "result.json").write_text(json.dumps(result, indent=1))
    return result


def load(name):
    r = json.loads((IRUNS / name / "result.json").read_text())
    labels = json.loads((IDATA / "meta.json").read_text())["intents"]
    m = IntentNet(r["buckets"], r["dim"], r["hidden"], len(labels), 0.0)
    m.load_state_dict(torch.load(IRUNS / name / "best.pt"))
    m.eval()
    return m, r, labels


def save_result(r, stage):
    rs = json.loads(RESULTS.read_text()) if RESULTS.exists() else []
    rs = [x for x in rs if x["name"] != r["name"]] + [{**r, "stage": stage}]
    RESULTS.write_text(json.dumps(rs, indent=1))


def best_name():
    rs = [r for r in json.loads(RESULTS.read_text()) if r["stage"] == "search"]
    rs.sort(key=lambda r: r["val_loss"])
    # the smallest network within 0.01 of the best validation loss
    ok = [r for r in rs if r["val_loss"] <= rs[0]["val_loss"] + 0.01]
    return min(ok, key=lambda r: r["params"])["name"]


# ---------- export: the network as the app reads it ----------
def quantize(w):
    """int8 per row: row = q * scale. Rows that are all zero get scale 0."""
    scale = np.abs(w).max(axis=1) / 127.0
    scale = np.array([float(f"{s:.6g}") for s in scale])
    q = np.where(scale[:, None] > 0, np.round(w / np.where(scale[:, None] > 0, scale[:, None], 1)), 0).astype(np.int8)
    return q, scale


def network_json(model, r, labels):
    w = model.emb.weight.detach().numpy().astype(np.float64)
    q, scale = quantize(w)
    layers = [{"w": [[round(float(v), 7) for v in row] for row in m.weight.detach().numpy()],
               "b": [round(float(v), 7) for v in m.bias.detach().numpy()]}
              for m in model.head if isinstance(m, nn.Linear)]
    return {
        "version": 1,
        "about": "Kitsu's intent network: hashed words, word pairs and 3-5 letter runs -> averaged embedding "
                 "-> (hidden ReLU layers) -> softmax over intents. See kitsunet/textfeat.py.",
        "intents": labels, "buckets": r["buckets"], "dim": r["dim"], "min_n": T.MIN_N, "max_n": T.MAX_N,
        "max_words": T.MAX_WORDS,
        "emb_q": base64.b64encode(q.tobytes()).decode(), "emb_scale": scale.tolist(),
        "layers": layers,
        "training": {"run": r["name"], "params": r["params"], "validation_loss": r["val_loss"],
                     "validation_accuracy": r["val_acc"]},
    }


def forward(net, text):
    """Reference maths in NumPy, written the way kitsunet.js does it."""
    B, D = net["buckets"], net["dim"]
    if "_emb" not in net:
        q = np.frombuffer(base64.b64decode(net["emb_q"]), dtype=np.int8).reshape(B, D).astype(np.float64)
        net["_emb"] = q * np.array(net["emb_scale"])[:, None]
        net["_layers"] = [(np.array(l["w"]), np.array(l["b"])) for l in net["layers"]]
    ids = T.ids(text, B)
    h = net["_emb"][ids].mean(axis=0) if ids else np.zeros(D)
    for i, (w, b) in enumerate(net["_layers"]):
        h = w @ h + b
        if i < len(net["_layers"]) - 1:
            h = np.maximum(h, 0)
    e = np.exp(h - h.max())
    return e / e.sum()


def exam_set(net, labels, rows, base=None):
    out = []
    for row in rows:
        p = forward(net, row["text"])
        top = np.argsort(-p)[:3]
        out.append({"text": row["text"], "want": row["intent"], "got": labels[top[0]], "p": round(float(p[top[0]]), 3),
                    "top3": [labels[i] for i in top]})
    r = {"messages": len(out), "accuracy": float(np.mean([o["want"] == o["got"] for o in out])),
         "top3": float(np.mean([o["want"] in o["top3"] for o in out])), "mistakes": [o for o in out if o["want"] != o["got"]]}
    if base:
        bm, br = base
        f, o, y = encode(rows, br["buckets"], labels, lambda t: words_only(t, br["buckets"]))
        r["baseline_accuracy"] = float(np.mean(probs(bm, f, o).argmax(1) == y.numpy()))
    return r


def exam(name):
    """
    Two sets of hand-written messages, neither augmented nor trained on:
      intent_exam.jsonl     the final exam, written before the second round of changes and used only here
      intent_heldout.jsonl  the first exam; its mistakes were looked at (and shaped intent_extra.jsonl),
                            so it is reported, but it is no longer a clean test
    """
    model, r, labels = load(name)
    net = network_json(model, r, labels)
    bpath = IRUNS / "words-softmax" / "result.json"
    base = None
    if bpath.exists():
        bm, br, _ = load("words-softmax")
        base = (bm, br)
    report = {"run": name}
    for key, fname in (("exam", "intent_exam.jsonl"), ("heldout_seen", "intent_heldout.jsonl")):
        x = exam_set(net, labels, read(HERE / fname), base)
        report[key] = x
        print(f"{fname}: {x['messages']} messages, {x['accuracy'] * 100:.1f}% right, top-3 {x['top3'] * 100:.1f}%"
              f"  (words-only baseline {x.get('baseline_accuracy', 0) * 100:.1f}%)")
        for m in x["mistakes"]:
            print(f"  want {m['want']:24} got {m['got']:24} p={m['p']:.2f}  {m['text']}")
    (IRUNS / name / "exam.json").write_text(json.dumps(report, indent=1))
    return report


def export(name):
    model, r, labels = load(name)
    net = network_json(model, r, labels)
    ex = IRUNS / name / "exam.json"
    if ex.exists():
        e = json.loads(ex.read_text())
        net["training"]["exam_accuracy"] = round(e["exam"]["accuracy"], 4)
        net["training"]["exam_messages"] = e["exam"]["messages"]
    # the quantized table must still give the trained network's answers
    va = read(IDATA / "val.jsonl")
    f, o, y = encode(va, r["buckets"], labels)
    want = probs(model, f, o)
    got = np.array([forward(net, row["text"]) for row in va])
    agree = float(np.mean(want.argmax(1) == got.argmax(1)))
    print(f"int8 table: same top intent on {agree * 100:.2f}% of validation, largest probability gap {np.abs(want - got).max():.4f}")
    WEB_OUT.mkdir(parents=True, exist_ok=True)
    text = json.dumps({k: v for k, v in net.items() if not k.startswith("_")}, separators=(",", ":"))
    assert len(text) < MAX_BYTES, f"intent.json is {len(text)} bytes"
    (WEB_OUT / "intent.json").write_text(text, encoding="utf-8")
    # golden: messages (hand-written ones, validation ones, odd ones) with the exact pieces, ids and probabilities
    msgs = [r["text"] for r in read(HERE / "intent_exam.jsonl")[:40]] + [r["text"] for r in va[::25]] + [
        "", "   ", "???", "WHAT SHOULD I READ RN", "recomend smth like s0lo levelling pls!!", "what’s new?",
        "café ñandú 漫画 manhwa", "a" * 60, " ".join(["more"] * 50), "it's 3am & i can't sleep... rec?"]
    gold = [{"text": m, "pieces": T.pieces(m), "ids": T.ids(m, net["buckets"]),
             "p": [round(float(v), 9) for v in forward(net, m)]} for m in msgs]
    gpath = WEB_OUT / "golden.json"
    g = json.loads(gpath.read_text(encoding="utf-8")) if gpath.exists() else {}
    g["intent"] = gold
    gpath.write_text(json.dumps(g, separators=(",", ":")), encoding="utf-8")
    print(f"intent.json: {len(text) / 1024:.0f} KB; golden: {len(gold)} messages")


def main(stage):
    IRUNS.mkdir(parents=True, exist_ok=True)
    log = lambda s: (print(s, flush=True), open(IRUNS / "search.log", "a").write(s + "\n"))
    if stage == "base":
        save_result(train("words-softmax", 8192, 32, 0, 0.0, words=True, log=log), "base")
    elif stage == "search":
        for name, b, d, h, do, keep, smooth in SEARCH:
            save_result(train(name, b, d, h, do, log=log, keep=keep, smooth=smooth), "search")
        rs = sorted(json.loads(RESULTS.read_text()), key=lambda r: r["val_loss"])
        for r in rs:
            log(f"  {r['name']:16} val_loss {r['val_loss']:.4f} val_acc {r['val_acc']:.4f} params {r['params']:>8,} ({r['stage']})")
        log(f"chosen: {best_name()}")
    elif stage == "exam":
        exam(sys.argv[2] if len(sys.argv) > 2 else best_name())
    elif stage == "export":
        export(sys.argv[2] if len(sys.argv) > 2 else best_name())


if __name__ == "__main__":
    main(sys.argv[1])
