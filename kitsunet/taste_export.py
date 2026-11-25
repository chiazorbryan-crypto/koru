"""
taste_export.py - step 5 of the taste network: write what the app needs.

  web/kitsunet/taste.json    scaling, weights, vocabulary, scan-site genre names -> AniList names, constants
  web/kitsunet/golden.json   ("taste" part) real test readers and made-up Koru ones, with the exact inputs
                             and answers kitsunet.js must reproduce (node kitsunet/check.mjs)

Run:   python kitsunet\\taste_export.py final-64-32-s0
"""
import json
import random
import sys

import numpy as np
import torch

import taste_features as TF
from common import PREPARED, WEB_OUT
from taste_train import TRUNS, load_model

# Genre names the scan sites use -> the AniList genre / tag they mean. Names that are already the same
# (after lower case and dropping spaces and punctuation) need no entry. Targets missing from the vocabulary
# are dropped at export.
ALIASES = {
    "scifi": "scifi", "sciencefiction": "scifi", "magicalgirls": "mahoushoujo", "magicalgirl": "mahoushoujo",
    "murim": "martialarts", "martialart": "martialarts", "wuxia": "wuxia", "xianxia": "cultivation", "xuanhuan": "cultivation",
    "schoollife": "school", "highschool": "school", "harem": "femaleharem", "reverseharem": "maleharem",
    "monster": "monsters", "demon": "demons", "vampire": "vampire", "vampires": "vampire", "zombie": "zombie", "zombies": "zombie",
    "genderbender": "genderbending", "genderswap": "genderbending", "game": "videogames", "games": "videogames", "gaming": "videogames",
    "videogame": "videogames", "gamer": "videogames", "virtualreality": "virtualreality", "vr": "virtualreality",
    "officeworkers": "office", "workplace": "office", "officelady": "officelady", "cooking": "food", "food": "food", "medical": "medicine", "doctor": "medicine",
    "police": "police", "superhero": "superhero", "superheroes": "superhero", "superpower": "superpower", "superpowers": "superpower",
    "timetravel": "timemanipulation", "regression": "ageregression", "regressor": "ageregression", "returner": "ageregression",
    "timeloop": "timeloop", "monsters": "monstergirl",
    "royalty": "royalaffairs", "nobility": "royalaffairs", "royal": "royalaffairs",
    "bl": "boyslove", "yaoi": "boyslove", "boyslove": "boyslove", "shounenai": "boyslove",
    "gl": "yuri", "girlslove": "yuri", "shoujoai": "yuri", "yuri": "yuri",
    "longstrip": "longstrip", "webtoon": "longstrip", "webtoons": "longstrip", "fullcolor": "fullcolor", "fullcolour": "fullcolor",
    "apocalypse": "postapocalyptic", "postapocalyptic": "postapocalyptic", "apocalyptic": "postapocalyptic",
    "modernfantasy": "urbanfantasy", "urbanfantasy": "urbanfantasy", "dungeons": "dungeon", "dungeon": "dungeon",
    "reincarnated": "reincarnation", "rebirth": "reincarnation", "transmigration": "isekai", "transmigrated": "isekai",
    "otherworld": "isekai", "anotherworld": "isekai", "villainess": "villainess", "villain": "antihero",
    "assassin": "assassins", "ninjas": "ninja", "samurais": "samurai", "mafia": "mafia", "gangster": "gangs", "gangsters": "gangs",
    "gangs": "gangs", "delinquent": "delinquents", "delinquents": "delinquents", "sport": "sports", "baseball": "baseball",
    "basketball": "basketball", "boxing": "boxing", "football": "football", "soccer": "football", "military": "military",
    "war": "war", "historical": "historical", "history": "historical", "mythology": "mythology", "gods": "gods", "god": "gods",
    "magic": "magic", "witch": "witch", "witches": "witch", "dragons": "dragons", "dragon": "dragons", "necromancer": "necromancy",
    "necromancy": "necromancy", "revenge": "revenge", "survival": "survival", "tragedy": "tragedy", "crime": "crime",
    "detective": "detective", "idols": "idol", "idol": "idol", "music": "music", "cultivation": "cultivation",
    "system": "videogames", "hunter": "dungeon", "hunters": "dungeon", "tower": "dungeon",
    "shonen": "shounen", "shoujo": "shoujo", "shojo": "shoujo", "seinen": "seinen", "josei": "josei", "shounen": "shounen",
    "sliceoflife": "sliceoflife", "psychological": "psychological", "thriller": "thriller", "supernatural": "supernatural",
    "mystery": "mystery", "romance": "romance", "comedy": "comedy", "drama": "drama", "horror": "horror", "fantasy": "fantasy",
    "action": "action", "adventure": "adventure", "ecchi": "ecchi", "mecha": "mecha", "mahoushoujo": "mahoushoujo",
    "isekai": "isekai", "reincarnation": "reincarnation", "martialarts": "martialarts", "school": "school",
}


def network_json(model, result, meta, report):
    layers = [{"w": [[round(float(v), 7) for v in row] for row in m.weight.detach().numpy()],
               "b": [round(float(v), 7) for v in m.bias.detach().numpy()]}
              for m in model.net if isinstance(m, torch.nn.Linear)]
    vocab = meta["vocab"]
    aliases = {k: v for k, v in sorted(ALIASES.items()) if v in vocab and k != v}
    C = dict(meta["constants"], tag_rank=TF.TAG_RANK, clear=TF.CLEAR, top=TF.TOP)
    test = None
    if report:
        test = {v: {"auc": round(r["network"]["auc"], 4), "accuracy": round(r["network"]["accuracy"], 4)} for v, r in report["views"].items()}
    return {
        "version": 1,
        "about": "Kitsu's taste network: the chance a reader finishes and enjoys a series (completed, or scored at or "
                 "above their own mean), from their other series. Hidden layers use ReLU; the output goes through a sigmoid. "
                 "See kitsunet/taste_features.py.",
        "features": TF.FEATURES,
        "mean": [round(float(v), 7) for v in model.mean.numpy()],
        "std": [round(float(v), 7) for v in model.std.numpy()],
        "layers": layers,
        "constants": {k: (round(v, 7) if isinstance(v, float) else v) for k, v in C.items()},
        "vocab": vocab, "names": meta["names"], "aliases": aliases, "koru": TF.KORU,
        "training": {"data": "AniList public manga lists", "readers": meta["readers"], "entries": meta["entries"],
                     "series": meta["series"], "run": result["name"], "hidden": result["hidden"], "params": result["params"],
                     "validation_log_loss": round(result["val_loss"], 5), "validation_auc": round(result["val_auc"], 5), "test": test},
    }


def forward(net, x):
    h = (np.asarray(x, dtype=np.float64) - np.array(net["mean"])) / np.array(net["std"])
    for i, layer in enumerate(net["layers"]):
        h = np.array(layer["w"]) @ h + np.array(layer["b"])
        if i < len(net["layers"]) - 1:
            h = np.maximum(h, 0.0)
    return float(1.0 / (1.0 + np.exp(-h[0])))


def norm_any(s, vocab, aliases):
    """Mirrors kitsunet.js normSeries: AniList media, a Koru series, or a Koru series carrying .anilist."""
    if s.get("provider") and s.get("slug") is not None:
        key = f"{s['provider']}:{s['slug']}"
    else:
        key = s.get("key") or (f"al:{s['id']}" if s.get("id") is not None else "")
    tags = s.get("tags")
    whole = not s.get("provider") and ("countryOfOrigin" in s or (isinstance(tags, list) and tags and isinstance(tags[0], dict)))
    a = s.get("anilist") or (s if whole else None)
    n = TF.normalize_media(a, vocab) if a else TF.normalize_koru(s, vocab, aliases)
    n["key"] = key or (f"al:{a.get('id')}" if a else "")
    return n


def slim(m):
    """The AniList fields the app reads (keeps golden.json small)."""
    return {"id": m["id"], "title": {"english": (m.get("title") or {}).get("english"), "romaji": (m.get("title") or {}).get("romaji")},
            "genres": m.get("genres") or [], "tags": [{"name": t["name"], "rank": t.get("rank"), "isMediaSpoiler": t.get("isMediaSpoiler")}
                                                       for t in m.get("tags") or []][:14],
            "countryOfOrigin": m.get("countryOfOrigin"), "format": m.get("format"), "status": m.get("status"),
            "chapters": m.get("chapters"), "averageScore": m.get("averageScore"), "popularity": m.get("popularity"),
            "startDate": {"year": (m.get("startDate") or {}).get("year")},
            "staff": {"edges": [{"node": {"name": {"full": ((e.get("node") or {}).get("name") or {}).get("full")}}}
                                for e in (m.get("staff") or {}).get("edges") or []][:4]}}


def koru_cases(rng, vocab, names):
    """Made-up Koru readers: series as scan sites describe them (genre names, status words, authors)."""
    site_tags = [names[k] for k in vocab] + ["Manhwa", "Manhua", "Manga", "Murim", "Regression", "System", "Webtoon", "Full Color",
                                             "School Life", "Harem", "Oneshot", "Sci-fi", "Science Fiction", "Shonen", "Unknown Tag"]
    statuses = ["Ongoing", "Completed", "Hiatus", "Dropped", "Not completed", "Releasing", "", "Season End", "Finished"]
    authors = ["Chugong", "Redice Studio · Dubu", "Kim Ann/Lee Bo", "Jang Sung-Lak", "Sung-Lak Jang & SIU", "", "Toika"]

    def series(i):
        s = {"provider": rng.choice(["asura", "mangadex", "webtoons"]), "slug": f"series-{i}", "title": f"Series {i}",
             "tags": rng.sample(site_tags, rng.randint(0, 7)), "status": rng.choice(statuses), "author": rng.choice(authors)}
        r = rng.random()
        if r < 0.3:
            s["total"] = rng.choice([12, 80, 250])
        elif r < 0.4:
            s["_chapters"] = [{}] * rng.randint(1, 9)
        if rng.random() < 0.15:
            s["country"] = rng.choice(["KR", "jp", "TW", "XX"])
        return s
    genre_names = [names[k] for k in vocab if vocab[k] == "genre"]
    tag_names = [names[k] for k in vocab if vocab[k] == "tag"]

    def card(i):
        """A Kitsu recommendation card (kitsu.js hands these to tasteMany): AniList names, no provider."""
        return {"kind": "ani", "title": f"Card {i}", "genres": rng.sample(genre_names, rng.randint(1, 4)),
                "tags": rng.sample(tag_names, rng.randint(0, 6)), "chapters": rng.choice([None, 45, 180]),
                "status": rng.choice(["FINISHED", "RELEASING", "HIATUS", "NOT_YET_RELEASED", ""]), "score": rng.choice([None, 61, 84]),
                "country": rng.choice(["KR", "JP", "CN", "TW", ""])}
    cases = []
    for c in range(3):
        pool = [series(c * 100 + i) for i in range(rng.randint(3, 25))]
        entries = [{"series": s, "status": rng.choice(TF.STATUSES), "score": rng.choice([0, 0, 20, 40, 60, 80, 90, 100])} for s in pool]
        targets = [rng.choice(pool) for _ in range(3)] + [series(c * 100 + 50 + i) for i in range(5)] + [card(c * 10 + i) for i in range(3)]
        cases.append((entries, targets))
    cases.append(([], [series(999)]))                                   # an empty profile
    return cases


def main(name):
    model, result = load_model(name)
    meta = json.loads((PREPARED / "meta.json").read_text())
    rp = TRUNS / name / "report_test.json"
    report = json.loads(rp.read_text()) if rp.exists() else None
    net = network_json(model, result, meta, report)

    # the exported numbers must reproduce the trained network
    X = torch.from_numpy(np.load(PREPARED / "val_X.npy")[:3000])
    with torch.no_grad():
        want = torch.sigmoid(model(X)).numpy()
    got = np.array([forward(net, r) for r in X.numpy()])
    gap = float(np.abs(want - got).max())
    assert gap < 1e-5, f"export does not match the trained network (gap {gap})"

    vocab, aliases = net["vocab"], net["aliases"]
    C = dict(meta["constants"], tag_order={t: i for i, t in enumerate(vocab)})
    rng = random.Random(5)
    import taste_prepare as P
    from common import split_users
    media = P.load_media()
    lists = P.readers(media)
    test = sorted(split_users(list(lists))["test"])
    gold = []
    for u in rng.sample(test, 6):
        es = lists[u]
        pick = rng.sample(es, min(30, len(es)))
        entries = [{"series": slim(media[e["mediaId"]]), "status": e["status"], "score": e["score"]} for e in pick]
        targets = [x["series"] for x in rng.sample(entries, min(4, len(entries)))]
        targets += [slim(media[m]) for m in rng.sample(sorted(media), 4)]
        m = media[rng.choice(sorted(media))]                       # a Koru series carrying its AniList media
        targets.append({"provider": "asura", "slug": f"s-{m['id']}", "title": "On a site", "tags": ["Action"], "anilist": slim(m)})
        gold.append((entries, targets))
    gold += koru_cases(rng, vocab, net["names"])
    cases = []
    for entries, targets in gold:
        norm = [{"series": norm_any(e["series"], vocab, aliases), "status": e["status"], "score": e["score"]} for e in entries]
        out = []
        for t in targets:
            s = norm_any(t, vocab, aliases)
            E = [e for e in norm if e["series"]["key"] != s["key"]]
            x = TF.reference_features(E, s, C)
            out.append({"series": t, "features": [round(v, 10) for v in x], "p": round(forward(net, x), 10)})
        cases.append({"entries": entries, "targets": out})
    WEB_OUT.mkdir(parents=True, exist_ok=True)
    text = json.dumps(net, separators=(",", ":"))
    (WEB_OUT / "taste.json").write_text(text, encoding="utf-8")
    gpath = WEB_OUT / "golden.json"
    g = json.loads(gpath.read_text(encoding="utf-8")) if gpath.exists() else {}
    g["taste"] = cases
    gpath.write_text(json.dumps(g, separators=(",", ":")), encoding="utf-8")
    ps = [t["p"] for c in cases for t in c["targets"]]
    print(f"taste.json: {len(text) / 1024:.0f} KB, {result['params']:,} weights, gap vs trained network {gap:.1e}")
    print(f"golden: {len(cases)} readers, {len(ps)} series, chances {min(ps):.3f}..{max(ps):.3f}")


if __name__ == "__main__":
    main(sys.argv[1])
