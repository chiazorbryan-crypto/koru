"""
taste_prepare.py - step 2 of the taste network: turn the downloaded lists into network inputs.

  * keeps readers with at least 5 started series (PLANNING is left out everywhere; novels too,
    since Koru only reads comics)
  * splits readers 80 / 10 / 10 into train / validation / test (common.split_users)
  * builds the genre / tag vocabulary and the smoothing constants from the TRAIN readers only
  * computes the inputs for every labelled series on every list, each series left out of its own
    profile (taste_features.user_rows)

Views, so the network learns to cope with what Koru actually knows:
  full   all AniList metadata, the whole list
  koru   only a site's genre list, status and (sometimes) chapter count, country and people;
         no popularity, score, year or format (taste_features.koru_like)
  small  a "fresh start": a random 5-80 series of the list, as in a new Koru install, koru-like metadata
Training readers get one full-or-koru view each (half and half) and 40% of them also a small one.
Validation and test readers get all three views, reported separately.

Run:   python kitsunet\\taste_prepare.py
"""
import json
import math
import time
from collections import Counter

import numpy as np

import taste_features as TF
from common import MEDIA_DIR, PREPARED, USERS_DIR, split_users

MIN_STARTED = 5
POOL_CAP = 600              # a few AniList lists have thousands of series; Koru libraries don't
TARGET_CAP = 250            # rows per reader per view, so the heaviest readers don't dominate
SMALL_SHARE = 0.4
SMALL_MIN, SMALL_MAX = 5, 80
VOCAB_MIN_SERIES = 25       # a tag must be on at least this many series to be in the vocabulary


ASKED = set()                 # every series id AniList was asked about (some answer nothing)
MIN_COVERED = 0.95            # a reader is used only once the metadata of nearly all their series is in


def load_media():
    media = {}
    for p in sorted(MEDIA_DIR.glob("*.json")):
        try:
            got = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            continue                                     # a batch still being written
        for k, m in got.items():
            ASKED.add(int(k))
            if m:
                media[int(k)] = m
    return media


def build_vocab(media, used):
    genres, tags = Counter(), Counter()
    for mid in used:
        m = media[mid]
        for g in m.get("genres") or []:
            genres[TF.tag_key(g)] += 1
        for t in m.get("tags") or []:
            if (t.get("rank") or 0) >= TF.TAG_RANK and not t.get("isMediaSpoiler"):
                tags[TF.tag_key(t["name"])] += 1
    vocab = {g: "genre" for g in genres}
    for t, c in tags.items():
        if c >= VOCAB_MIN_SERIES and t not in vocab:
            vocab[t] = "tag"
    names = {}
    for mid in used:
        m = media[mid]
        for g in m.get("genres") or []:
            names.setdefault(TF.tag_key(g), g)
        for t in m.get("tags") or []:
            names.setdefault(TF.tag_key(t["name"]), t["name"])
    return dict(sorted(vocab.items())), {k: names[k] for k in sorted(vocab)}


def readers(media):
    out = {}
    for p in USERS_DIR.glob("*.json"):
        j = json.loads(p.read_text(encoding="utf-8"))
        if not j.get("entries"):
            continue
        started = [e for e in j["entries"] if e["status"] in TF.STATUSES]
        if ASKED and started and sum(e["mediaId"] in ASKED for e in started) < MIN_COVERED * len(started):
            continue                                     # the download stopped before this reader's series were all in
        es = [e for e in started if e["mediaId"] in media and media[e["mediaId"]].get("format") != "NOVEL"]
        if len(es) >= MIN_STARTED:
            out[j["user"]] = es
    return out


def constants(train_lists, series):
    st, pos, lab, scores, pops, avgs, chs = Counter(), 0, 0, [], [], [], []
    for es in train_lists:
        m = TF.mean_score([{"score": e["score"]} for e in es])
        for e in es:
            st[e["status"]] += 1
            l = TF.label(e["status"], e["score"], m)
            if l is not None:
                lab += 1
                pos += l
            if e["score"]:
                scores.append(e["score"])
            s = series[e["mediaId"]]
            if s["pop"]:
                pops.append(math.log1p(s["pop"]))
            if s["avg"]:
                avgs.append(s["avg"] / 100)
            if s["chapters"] and e["status"] in ("COMPLETED", "REPEATING"):
                chs.append(math.log1p(s["chapters"]))
    n = sum(st.values())
    return {"k": TF.K, "p_comp": (st["COMPLETED"] + st["REPEATING"]) / n, "p_drop": st["DROPPED"] / n, "p_pos": pos / lab,
            "mean0": float(np.mean(scores)), "pop0": float(np.mean(pops)), "avg0": float(np.mean(avgs)), "ch0": float(np.mean(chs))}


def view_rows(es, series, C, V, tag_index, order_rank, rng, koru, small):
    if small:
        k = int(round(math.exp(rng.uniform(math.log(SMALL_MIN), math.log(SMALL_MAX)))))
        es = [es[i] for i in sorted(rng.choice(len(es), min(k, len(es)), replace=False))]
    elif len(es) > POOL_CAP:
        es = [es[i] for i in sorted(rng.choice(len(es), POOL_CAP, replace=False))]
    entries = []
    for e in es:
        s = series[e["mediaId"]]
        entries.append({"series": TF.koru_like(s, rng) if koru else s, "status": e["status"], "score": e["score"]})
    m = TF.mean_score(entries)
    labs = [TF.label(e["status"], e["score"], m) for e in entries]
    targets = [i for i, l in enumerate(labs) if l is not None]
    if len(entries) < 2 or not targets:
        return None
    if len(targets) > TARGET_CAP:
        targets = sorted(rng.choice(targets, TARGET_CAP, replace=False).tolist())
    X = TF.user_rows(entries, targets, C, V, tag_index, order_rank)
    y = np.array([labs[i] for i in targets], dtype=np.uint8)
    return X, y


def main():
    t0 = time.time()
    media = load_media()
    lists = readers(media)
    used = {e["mediaId"] for es in lists.values() for e in es}
    print(f"{len(lists)} readers, {sum(len(v) for v in lists.values()):,} started entries, {len(used):,} series")
    splits = split_users(list(lists))
    train_used = {e["mediaId"] for u in splits["train"] for e in lists[u]}
    vocab, names = build_vocab(media, train_used)
    V = len(vocab)
    tag_index = {t: i for i, t in enumerate(vocab)}
    order_rank = np.arange(V, dtype=np.float64)                 # the vocabulary is already in alphabetical order
    series = {mid: TF.normalize_media(media[mid], vocab) for mid in used}
    C = constants([lists[u] for u in splits["train"]], series)
    C["tag_order"] = {t: i for i, t in enumerate(vocab)}
    print(f"vocabulary: {sum(1 for v in vocab.values() if v == 'genre')} genres, {sum(1 for v in vocab.values() if v == 'tag')} tags")
    print("constants:", {k: round(v, 4) for k, v in C.items() if k != "tag_order"})

    PREPARED.mkdir(parents=True, exist_ok=True)
    meta = {"features": TF.FEATURES, "constants": {k: v for k, v in C.items() if k != "tag_order"},
            "vocab": vocab, "names": names, "splits": {}}
    for name in ("train", "val", "test"):
        rng = np.random.default_rng({"train": 1, "val": 2, "test": 3}[name])
        Xs, ys, us, vs = [], [], [], []
        for u in sorted(splits[name]):
            es = lists[u]
            if name == "train":
                views = [("koru" if rng.random() < 0.5 else "full", False)]
                if rng.random() < SMALL_SHARE:
                    views.append(("small", True))
            else:
                views = [("full", False), ("koru", False), ("small", True)]
            for view, small in views:
                r = view_rows(es, series, C, V, tag_index, order_rank, rng, koru=view != "full", small=small)
                if r is None:
                    continue
                Xs.append(r[0].astype(np.float32))
                ys.append(r[1])
                us.append(np.full(len(r[1]), u, dtype=np.int64))
                vs.append(np.full(len(r[1]), ["full", "koru", "small"].index(view), dtype=np.uint8))
        X, y, uid, view = np.concatenate(Xs), np.concatenate(ys), np.concatenate(us), np.concatenate(vs)
        assert np.isfinite(X).all()
        np.save(PREPARED / f"{name}_X.npy", X)
        np.save(PREPARED / f"{name}_y.npy", y)
        np.save(PREPARED / f"{name}_uid.npy", uid)
        np.save(PREPARED / f"{name}_view.npy", view)
        meta["splits"][name] = {"readers": len(splits[name]), "rows": int(len(y)), "positive": float(y.mean()),
                                "rows_by_view": {v: int((view == i).sum()) for i, v in enumerate(["full", "koru", "small"])}}
        print(f"{name}: {len(splits[name])} readers, {len(y):,} rows, {y.mean() * 100:.1f}% positive ({time.time() - t0:.0f}s)", flush=True)
    meta["readers"] = len(lists)
    meta["entries"] = sum(len(v) for v in lists.values())
    meta["series"] = len(used)
    (PREPARED / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
