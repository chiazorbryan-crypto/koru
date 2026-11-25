"""
check_taste.py - proves the fast feature code (taste_features.user_rows, used for training) and the
simple reference (taste_features.reference_features, which kitsunet.js copies) give the same numbers.

Run after taste_prepare.py:   python kitsunet\\check_taste.py [readers]
With "synthetic" it checks made-up lists instead (no download needed).
"""
import json
import random
import sys

import numpy as np

import taste_features as TF
from common import PREPARED


def compare(lists, series, C, vocab, rng, koru=False):
    V = len(vocab)
    tag_index = {t: i for i, t in enumerate(vocab)}
    order_rank = np.arange(V, dtype=np.float64)
    worst, rows = 0.0, 0
    for es in lists:
        entries = [{"series": TF.koru_like(series[e["mediaId"]], rng) if koru else series[e["mediaId"]],
                    "status": e["status"], "score": e["score"]} for e in es]
        targets = list(range(len(entries)))
        fast = TF.user_rows(entries, targets, C, V, tag_index, order_rank)
        for r, i in enumerate(targets):
            ref = TF.reference_features(entries[:i] + entries[i + 1:], entries[i]["series"], C)
            gap = np.abs(np.array(ref) - fast[r])
            if gap.max() > worst:
                worst = float(gap.max())
                if worst > 1e-9:
                    print(f"  gap {worst:.2e} in {TF.FEATURES[int(gap.argmax())]}")
            rows += 1
    return worst, rows


def synthetic():
    rng = random.Random(3)
    vocab = {f"g{i}": "genre" for i in range(6)} | {f"t{i:02d}": "tag" for i in range(30)}
    vocab = dict(sorted(vocab.items()))
    media = {}
    for mid in range(300):
        media[mid] = {"id": mid, "genres": [f"G{i}" for i in rng.sample(range(7), rng.randint(0, 3))],
                      "tags": [{"name": f"T{i:02d}", "rank": rng.choice([40, 60, 75, 90]), "isMediaSpoiler": rng.random() < 0.1}
                               for i in rng.sample(range(34), rng.randint(0, 8))],
                      "countryOfOrigin": rng.choice(["KR", "JP", "CN", "TW", None]), "format": rng.choice(["MANGA", "ONE_SHOT", None]),
                      "status": rng.choice(["FINISHED", "RELEASING", "HIATUS", "CANCELLED", None]),
                      "chapters": rng.choice([None, 1, 40, 200]), "popularity": rng.choice([None, 10, 5000, 300000]),
                      "averageScore": rng.choice([None, 55, 72, 88]), "startDate": {"year": rng.choice([None, 1999, 2018, 2024])},
                      "staff": {"edges": [{"node": {"name": {"full": rng.choice(["Kim Ann", "Ann Kim", "Lee Bo", "Sato Y", "Chugong"])}}}
                                          for _ in range(rng.randint(0, 2))]}}
    series = {mid: TF.normalize_media(m, vocab) for mid, m in media.items()}
    lists = []
    for _ in range(40):
        ids = rng.sample(range(300), rng.randint(2, 60))
        lists.append([{"mediaId": i, "status": rng.choice(TF.STATUSES), "score": rng.choice([0, 0, 30, 50, 60, 70, 80, 85, 100])} for i in ids])
    C = {"p_comp": 0.4, "p_drop": 0.1, "p_pos": 0.7, "mean0": 72.0, "pop0": 8.0, "avg0": 0.7, "ch0": 4.0,
         "tag_order": {t: i for i, t in enumerate(vocab)}}
    return lists, series, C, vocab


def main(arg):
    nprng = np.random.default_rng(0)
    if arg == "synthetic":
        lists, series, C, vocab = synthetic()
    else:
        import taste_prepare as P
        meta = json.loads((PREPARED / "meta.json").read_text())
        vocab = meta["vocab"]
        C = dict(meta["constants"], tag_order={t: i for i, t in enumerate(vocab)})
        media = P.load_media()
        allr = P.readers(media)
        pick = sorted(allr)[:: max(1, len(allr) // int(arg))][: int(arg)]
        lists = [allr[u][:150] for u in pick]
        series = {e["mediaId"]: TF.normalize_media(media[e["mediaId"]], vocab) for es in lists for e in es}
    for koru in (False, True):
        worst, rows = compare(lists, series, C, vocab, nprng, koru)
        print(f"{'koru-like' if koru else 'full'}: {rows:,} rows, largest gap {worst:.2e}")
        assert worst < 1e-9, "the fast and reference features disagree"
    print("fast and reference features agree")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "40")
