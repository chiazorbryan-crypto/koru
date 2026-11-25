"""
taste_features.py - the inputs of the taste network: will this reader finish and enjoy this series?

Two versions of the same maths:
  * reference_features(): plain loops over one profile and one series. web/js/kitsunet.js
    copies this function line by line.
  * user_rows(): the same numbers for every series on one reader's list at once (matrices),
    used to build the training data. check_taste.py proves the two agree.

Everything here can be computed by Koru from its own data (favourites, ratings, read marks,
completed / trash marks, genres from the series pages) plus AniList metadata when it has it.
Missing metadata gets a "has_..." input of 0, and training hides metadata the same way.

A profile is a list of entries the reader has STARTED: {series, status, score}
  status: COMPLETED, CURRENT, PAUSED, DROPPED or REPEATING (PLANNING is left out everywhere)
  score:  0..100, 0 = not scored
A series (normalized) is:
  {key, tags: [vocab keys, genres and tags], genres: set, top: [tags by rank], country: KR/JP/CN/'',
   oneshot: 0/1/None, status: FINISHED/RELEASING/HIATUS/CANCELLED/'', chapters, pop, avg, year, staff: [names]}

Label (what the network predicts) for one entry, with m = the reader's mean score:
  DROPPED                       -> 0
  scored, score >= m            -> 1
  scored, score <= m - 10       -> 0      ("clearly below": 10 points on the 100 scale)
  COMPLETED or REPEATING        -> 1      (finished, and not clearly disliked)
  otherwise                     -> none   (still reading, unscored: left out)
"""
import math
import re

import numpy as np

K = 5.0                    # smoothing: rates are pulled toward the reader's (or everyone's) rate by 5 entries
TAG_RANK = 60              # AniList tags at or above this rank (and not spoilers) count, like a site's genre list
TOP = 10                   # "your top tags": the 10 you read most
CLEAR = 10                 # points below your mean that count as "clearly below"
KORU_TOP_TAGS = 4          # Koru-like view: genres plus this many of the highest-ranked tags

STATUSES = ("COMPLETED", "CURRENT", "PAUSED", "DROPPED", "REPEATING")
S_STATUS = ("FINISHED", "RELEASING", "HIATUS", "CANCELLED")

FEATURES = [
    # the reader (from their other entries)
    "u_n", "u_comp", "u_drop", "u_pos", "u_lab", "u_scored", "u_mean",
    # the series
    "s_kr", "s_jp", "s_cn", "s_has_country", "s_fin", "s_rel", "s_hia", "s_can", "s_has_status",
    "s_oneshot", "s_has_format", "s_ch", "s_has_ch", "s_pop", "s_has_pop", "s_avg", "s_has_avg",
    "s_year", "s_has_year", "s_ntags",
    # the reader x the series's genres, then its tags
    "g_share", "g_pos", "g_comp", "g_drop", "g_min", "g_max",
    "t_share", "t_pos", "t_comp", "t_drop", "t_min", "t_max",
    "top_overlap", "fav_overlap",
    # same country, same people
    "c_share", "c_pos", "c_comp", "st_n", "st_pos", "st_has",
    # popularity, score and length compared with what the reader usually reads
    "pop_diff", "avg_diff", "ch_diff",
    # how the reader does with series of the same publishing status (finished, releasing...)
    "z_share", "z_pos", "z_comp",
]
N_FEATURES = len(FEATURES)

GROUPS = {
    "user": FEATURES[0:7],
    "series": FEATURES[7:27],
    "tags": FEATURES[27:41],
    "country_staff": FEATURES[41:47],
    "compare": FEATURES[47:50],
    "same_status": FEATURES[50:53],
}


def tag_key(name):
    return re.sub(r"[^a-z0-9]+", "", str(name or "").lower().replace("science fiction", "scifi"))


def staff_key(name):
    """Name parts in any order, glued: "Chu-Gong", "Chugong" and "Gong Chu" all become "chugong"."""
    words = sorted(w for w in re.split(r"[^a-z0-9]+", str(name or "").lower()) if w)
    return "".join(words)


def normalize_media(m, vocab):
    """An AniList media object -> the normalized series (kitsunet.js has the same function)."""
    genres = [tag_key(g) for g in (m.get("genres") or [])]
    ranked = sorted(((t.get("rank") or 0, tag_key(t.get("name"))) for t in (m.get("tags") or [])
                     if (t.get("rank") or 0) >= TAG_RANK and not t.get("isMediaSpoiler")), key=lambda x: (-x[0], x[1]))
    top = [k for _, k in ranked if k in vocab and vocab[k] == "tag"]
    gs = [g for g in genres if g in vocab]
    tags = list(dict.fromkeys(gs + top))
    c = m.get("countryOfOrigin") or ""
    fmt = m.get("format")
    st = m.get("status") or ""
    staff = []
    for e in ((m.get("staff") or {}).get("edges") or []):
        k = staff_key(((e.get("node") or {}).get("name") or {}).get("full"))
        if k and k not in staff:
            staff.append(k)
    year = (m.get("startDate") or {}).get("year")
    return {
        "key": "al:" + str(m.get("id")), "tags": tags, "genres": set(gs), "top": top,
        "country": "CN" if c == "TW" else c if c in ("KR", "JP", "CN") else "",
        "oneshot": None if fmt not in ("MANGA", "ONE_SHOT") else (1 if fmt == "ONE_SHOT" else 0),
        "status": st if st in S_STATUS else "",
        "chapters": m.get("chapters") or None, "pop": m.get("popularity") or None,
        "avg": m.get("averageScore") or None, "year": year or None, "staff": staff,
    }


# What a Koru series (a scan site's page) can tell: these words in its genre list give the country,
# "oneshot" the format. Sites list a chapter count for ongoing series too, but AniList mostly only has
# one once a series is finished, so a Koru chapter count is only used for finished series.
KORU = {"country": {"manhwa": "KR", "korean": "KR", "manhua": "CN", "chinese": "CN", "manga": "JP", "japanese": "JP"},
        "oneshot": ["oneshot"], "finished_chapters_only": True}


def koru_status(text):
    t = str(text or "").lower()
    if re.search(r"hiatus", t):
        return "HIATUS"
    if re.search(r"cancel|discontinu|dropped|axed", t):
        return "CANCELLED"
    if re.search(r"\b(not|ongoing|upcoming|yet)\b|on ?going|releasing|publishing|serializ", t):
        return "RELEASING"
    if re.search(r"complet|finish|ended|concluded|\bend\b|\bdone\b", t):
        return "FINISHED"
    return ""


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 else None


def normalize_koru(s, vocab, aliases):
    """A Koru series ({provider, slug, tags: [names], status, author, total}) -> the normalized series."""
    names = []
    for t in list(s.get("genres") or []) + list(s.get("tags") or []):          # names, or AniList tag objects
        if isinstance(t, str):
            names.append(t)
        elif isinstance(t, dict) and not t.get("isMediaSpoiler") and (t.get("rank") is None or t["rank"] >= TAG_RANK) \
                and isinstance(t.get("name"), str):
            names.append(t["name"])
    raw = [tag_key(t) for t in names]
    keys = []
    for k in raw:
        v = aliases.get(k, k)
        if v in vocab and v not in keys:
            keys.append(v)
    genres = [k for k in keys if vocab[k] == "genre"]
    top = [k for k in keys if vocab[k] == "tag"]
    c = str(s.get("country") or s.get("countryOfOrigin") or "").upper()
    c = "CN" if c == "TW" else c if c in ("KR", "JP", "CN") else ""
    if not c:
        hits = {KORU["country"][k] for k in raw if k in KORU["country"]}
        c = hits.pop() if len(hits) == 1 else ""
    status = koru_status(s.get("status"))
    ch = _num(s.get("chapters")) or _num(s.get("total")) or (len(s["_chapters"]) if isinstance(s.get("_chapters"), list) and s["_chapters"] else None)
    if KORU["finished_chapters_only"] and status != "FINISHED":
        ch = None
    staff = []
    for n in re.split(r"\s*(?:·|,|/|&|;|\band\b)\s*", str(s.get("author") or "")):
        k = staff_key(n)
        if k and k not in staff:
            staff.append(k)
    return {"key": f"{s.get('provider')}:{s.get('slug')}", "tags": genres + top, "genres": set(genres), "top": top,
            "country": c, "oneshot": 1 if any(k in KORU["oneshot"] for k in raw) else None, "status": status,
            "chapters": ch, "pop": _num(s.get("popularity")),
            "avg": _num(s.get("averageScore")) or (_num(s.get("score")) if s.get("kind") == "ani" else None),
            "year": _num(s.get("year")) or _num((s.get("startDate") or {}).get("year") if isinstance(s.get("startDate"), dict) else None),
            "staff": staff}


def koru_like(s, rng):
    """What Koru usually knows about a series without AniList: a site's genre list, its status and chapter count."""
    t = dict(s)
    t["tags"] = list(dict.fromkeys([g for g in s["tags"] if g in s["genres"]] + s["top"][:KORU_TOP_TAGS]))
    if rng.random() < 0.25:
        t["tags"] = []                     # Koru only knows the genres of series whose page it has looked at lately
    t["pop"] = t["avg"] = t["year"] = t["oneshot"] = None
    if rng.random() < 0.4:
        t["chapters"] = None
    if rng.random() < 0.4:
        t["country"] = ""
    if rng.random() < 0.5:
        t["staff"] = []
    return t


def label(status, score, mean):
    if status == "DROPPED":
        return 0
    if score and mean is not None:
        if score >= mean:
            return 1
        if score <= mean - CLEAR:
            return 0
    if status in ("COMPLETED", "REPEATING"):
        return 1
    return None


def mean_score(entries):
    s = [e["score"] for e in entries if e["score"]]
    return sum(s) / len(s) if s else None


def _lg(x):
    return math.log1p(x) if x else 0.0


# ---------- the reference version (kitsunet.js copies this) ----------
def reference_features(entries, s, C):
    """entries: the reader's profile WITHOUT this series. s: normalized series. C: constants."""
    n = len(entries)
    m = mean_score(entries)
    labs = [label(e["status"], e["score"], m) for e in entries]
    comp = [1 if e["status"] in ("COMPLETED", "REPEATING") else 0 for e in entries]
    drop = [1 if e["status"] == "DROPPED" else 0 for e in entries]
    nL = sum(1 for l in labs if l is not None)
    P = sum(1 for l in labs if l == 1)
    scored = [e["score"] for e in entries if e["score"]]
    u_comp = (sum(comp) + K * C["p_comp"]) / (n + K)
    u_drop = (sum(drop) + K * C["p_drop"]) / (n + K)
    u_pos = (P + K * C["p_pos"]) / (nL + K)
    f = {
        "u_n": _lg(n), "u_comp": u_comp, "u_drop": u_drop, "u_pos": u_pos,
        "u_lab": nL / n if n else 0.0, "u_scored": len(scored) / n if n else 0.0,
        "u_mean": (sum(scored) + K * C["mean0"]) / (len(scored) + K) / 100.0,
    }
    c = s["country"]
    f.update({"s_kr": float(c == "KR"), "s_jp": float(c == "JP"), "s_cn": float(c == "CN"), "s_has_country": float(c != "")})
    st = s["status"]
    f.update({"s_fin": float(st == "FINISHED"), "s_rel": float(st == "RELEASING"), "s_hia": float(st == "HIATUS"),
              "s_can": float(st == "CANCELLED"), "s_has_status": float(st != "")})
    f["s_oneshot"] = float(s["oneshot"] or 0)
    f["s_has_format"] = float(s["oneshot"] is not None)
    f["s_ch"], f["s_has_ch"] = _lg(s["chapters"]), float(bool(s["chapters"]))
    f["s_pop"], f["s_has_pop"] = _lg(s["pop"]), float(bool(s["pop"]))
    f["s_avg"], f["s_has_avg"] = (s["avg"] or 0) / 100.0, float(bool(s["avg"]))
    f["s_year"], f["s_has_year"] = ((s["year"] - 2000) / 10.0 if s["year"] else 0.0), float(bool(s["year"]))
    f["s_ntags"] = _lg(len(s["tags"]))

    # per-tag counts over the profile
    cnt, lab, pos, cmp_, drp = {}, {}, {}, {}, {}
    for e, l, co, dr in zip(entries, labs, comp, drop):
        for t in e["series"]["tags"]:
            cnt[t] = cnt.get(t, 0) + 1
            cmp_[t] = cmp_.get(t, 0) + co
            drp[t] = drp.get(t, 0) + dr
            if l is not None:
                lab[t] = lab.get(t, 0) + 1
                pos[t] = pos.get(t, 0) + l
    for prefix, group in (("g", [t for t in s["tags"] if t in s["genres"]]), ("t", [t for t in s["tags"] if t not in s["genres"]])):
        if not group:
            f.update({prefix + "_share": 0.0, prefix + "_pos": 0.0, prefix + "_comp": 0.0, prefix + "_drop": 0.0,
                      prefix + "_min": 0.0, prefix + "_max": 0.0})
            continue
        sc = sum(cnt.get(t, 0) for t in group)
        sl = sum(lab.get(t, 0) for t in group)
        sp = sum(pos.get(t, 0) for t in group)
        rates = [(pos.get(t, 0) + K * u_pos) / (lab.get(t, 0) + K) for t in group]
        f[prefix + "_share"] = sc / len(group) / n if n else 0.0
        f[prefix + "_pos"] = (sp + K * u_pos) / (sl + K) - u_pos
        f[prefix + "_comp"] = (sum(cmp_.get(t, 0) for t in group) + K * u_comp) / (sc + K) - u_comp
        f[prefix + "_drop"] = (sum(drp.get(t, 0) for t in group) + K * u_drop) / (sc + K) - u_drop
        f[prefix + "_min"] = min(rates) - u_pos
        f[prefix + "_max"] = max(rates) - u_pos
    order = C["tag_order"]                     # tag key -> its place in alphabetical order (ties go to the earlier name)
    top = sorted((t for t in cnt if cnt[t] > 0), key=lambda t: (-cnt[t], order.get(t, 1e9)))[:TOP]
    fav = sorted((t for t in pos if pos[t] > 0), key=lambda t: (-pos[t], order.get(t, 1e9)))[:TOP]
    denom = min(TOP, len(s["tags"]))
    f["top_overlap"] = sum(1 for t in s["tags"] if t in top) / denom if denom else 0.0
    f["fav_overlap"] = sum(1 for t in s["tags"] if t in fav) / denom if denom else 0.0

    if c:
        cc = cl = cp = ccomp = 0
        for e, l, co in zip(entries, labs, comp):
            if e["series"]["country"] == c:
                cc += 1
                ccomp += co
                if l is not None:
                    cl += 1
                    cp += l
        f["c_share"] = cc / n if n else 0.0
        f["c_pos"] = (cp + K * u_pos) / (cl + K) - u_pos
        f["c_comp"] = (ccomp + K * u_comp) / (cc + K) - u_comp
    else:
        f["c_share"] = f["c_pos"] = f["c_comp"] = 0.0
    if st:
        zc = zl = zp = zcomp = 0
        for e, l, co in zip(entries, labs, comp):
            if e["series"]["status"] == st:
                zc += 1
                zcomp += co
                if l is not None:
                    zl += 1
                    zp += l
        f["z_share"] = zc / n if n else 0.0
        f["z_pos"] = (zp + K * u_pos) / (zl + K) - u_pos
        f["z_comp"] = (zcomp + K * u_comp) / (zc + K) - u_comp
    else:
        f["z_share"] = f["z_pos"] = f["z_comp"] = 0.0
    mine = set(s["staff"])
    sn = sl_ = sp_ = 0
    if mine:
        for e, l in zip(entries, labs):
            if any(x in mine for x in e["series"]["staff"]):
                sn += 1
                if l is not None:
                    sl_ += 1
                    sp_ += l
    f["st_n"] = _lg(sn)
    f["st_pos"] = (sp_ + K * u_pos) / (sl_ + K) - u_pos if mine else 0.0
    f["st_has"] = float(bool(mine))

    pops = [_lg(e["series"]["pop"]) for e in entries if e["series"]["pop"]]
    avgs = [e["series"]["avg"] / 100.0 for e in entries if e["series"]["avg"]]
    chs = [_lg(e["series"]["chapters"]) for e, co in zip(entries, comp) if co and e["series"]["chapters"]]
    f["pop_diff"] = f["s_pop"] - (sum(pops) + K * C["pop0"]) / (len(pops) + K) if s["pop"] else 0.0
    f["avg_diff"] = f["s_avg"] - (sum(avgs) + K * C["avg0"]) / (len(avgs) + K) if s["avg"] else 0.0
    f["ch_diff"] = f["s_ch"] - (sum(chs) + K * C["ch0"]) / (len(chs) + K) if s["chapters"] else 0.0
    return [float(f[name]) for name in FEATURES]


# ---------- the fast version (every target of one reader at once) ----------
def user_rows(entries, targets, C, V, tag_index, order_rank):
    """
    entries: the reader's whole profile pool; targets: indices into it to score (each one is left out
    of its own profile). V: vocabulary size; tag_index: tag key -> column; order_rank: column -> place
    in alphabetical order. Returns an array (len(targets), N_FEATURES).
    """
    n_all = len(entries)
    T = len(targets)
    tg = np.asarray(targets)
    X = np.zeros((n_all, V))
    G = np.zeros((n_all, V))                     # genre columns of each entry's own tags
    for j, e in enumerate(entries):
        for t in e["series"]["tags"]:
            X[j, tag_index[t]] = 1.0
            if t in e["series"]["genres"]:
                G[j, tag_index[t]] = 1.0
    score = np.array([e["score"] for e in entries], dtype=np.float64)
    status = [e["status"] for e in entries]
    comp = np.array([1.0 if s in ("COMPLETED", "REPEATING") else 0.0 for s in status])
    drop = np.array([1.0 if s == "DROPPED" else 0.0 for s in status])
    has_s = score > 0
    S, nS = score[has_s].sum(), int(has_s.sum())

    n = n_all - 1
    # the mean of the profile without each target
    self_s = score[tg] * has_s[tg]
    cnt_s = nS - has_s[tg].astype(np.int64)
    means = np.where(cnt_s > 0, (S - self_s) / np.maximum(cnt_s, 1), np.nan)
    # labels of every entry, under each target's leave-one-out mean
    sc = score[None, :]
    m = means[:, None]
    has_m = ~np.isnan(m)
    one = np.where(has_m & has_s[None, :] & (sc >= np.nan_to_num(m)), 1, -1)
    zero = np.where(has_m & has_s[None, :] & (sc <= np.nan_to_num(m) - CLEAR), 1, 0)
    LAB = np.full((T, n_all), -1, dtype=np.int64)
    fin = (comp > 0)[None, :]
    LAB = np.where(fin, 1, LAB)
    LAB = np.where(zero == 1, 0, LAB)
    LAB = np.where(one == 1, 1, LAB)
    LAB = np.where((drop > 0)[None, :], 0, LAB)
    LAB[np.arange(T), tg] = -1
    POS = (LAB == 1).astype(np.float64)
    LABM = (LAB >= 0).astype(np.float64)
    nL = LABM.sum(1)
    P = POS.sum(1)
    keep = np.ones((T, n_all))
    keep[np.arange(T), tg] = 0.0

    out = np.zeros((T, N_FEATURES))
    F = {name: i for i, name in enumerate(FEATURES)}
    u_comp = (comp.sum() - comp[tg] + K * C["p_comp"]) / (n + K)
    u_drop = (drop.sum() - drop[tg] + K * C["p_drop"]) / (n + K)
    u_pos = (P + K * C["p_pos"]) / (nL + K)
    out[:, F["u_n"]] = math.log1p(n) if n else 0.0
    out[:, F["u_comp"]], out[:, F["u_drop"]], out[:, F["u_pos"]] = u_comp, u_drop, u_pos
    out[:, F["u_lab"]] = nL / n if n else 0.0
    out[:, F["u_scored"]] = cnt_s / n if n else 0.0
    out[:, F["u_mean"]] = (S - self_s + K * C["mean0"]) / (cnt_s + K) / 100.0

    ser = [entries[i]["series"] for i in targets]
    for r, s in enumerate(ser):
        ref_series_part(out[r], s, F)

    cnt_all = X.sum(0)
    cnt_t = cnt_all[None, :] - X[tg]                       # (T, V)
    comp_t = (comp @ X)[None, :] - comp[tg, None] * X[tg]
    drop_t = (drop @ X)[None, :] - drop[tg, None] * X[tg]
    pos_t = POS @ X
    lab_t = LABM @ X
    Xt, Gt = X[tg], G[tg]
    At = Xt - Gt
    for prefix, M in (("g", Gt), ("t", At)):
        k = M.sum(1)
        has = k > 0
        sc_ = (cnt_t * M).sum(1)
        sl = (lab_t * M).sum(1)
        sp = (pos_t * M).sum(1)
        rates = (pos_t + K * u_pos[:, None]) / (lab_t + K)
        rmin = np.where(M > 0, rates, np.inf).min(1)
        rmax = np.where(M > 0, rates, -np.inf).max(1)
        z = lambda v: np.where(has, v, 0.0)
        out[:, F[prefix + "_share"]] = z(sc_ / np.maximum(k, 1) / n) if n else 0.0
        out[:, F[prefix + "_pos"]] = z((sp + K * u_pos) / (sl + K) - u_pos)
        out[:, F[prefix + "_comp"]] = z(((comp_t * M).sum(1) + K * u_comp) / (sc_ + K) - u_comp)
        out[:, F[prefix + "_drop"]] = z(((drop_t * M).sum(1) + K * u_drop) / (sc_ + K) - u_drop)
        out[:, F[prefix + "_min"]] = z(rmin - u_pos)
        out[:, F[prefix + "_max"]] = z(rmax - u_pos)
    # top tags: most read first, ties to the alphabetically earlier name
    rank = order_rank[None, :]
    def top_mask(count):
        key = np.where(count > 0, count * (V + 1) + (V - rank), -1.0)
        idx = np.argsort(-key, axis=1, kind="stable")[:, :TOP]
        mask = np.zeros_like(count)
        np.put_along_axis(mask, idx, 1.0, axis=1)
        return mask * (count > 0)
    denom = np.minimum(TOP, Xt.sum(1))
    for name, count in (("top_overlap", cnt_t), ("fav_overlap", pos_t)):
        out[:, F[name]] = np.where(denom > 0, (top_mask(count) * Xt).sum(1) / np.maximum(denom, 1), 0.0)

    codes = {"": 0, "KR": 1, "JP": 2, "CN": 3}
    cty = np.array([codes[e["series"]["country"]] for e in entries])
    same = (cty[None, :] == cty[tg, None]).astype(np.float64) * keep            # (T, n_all)
    has_c = cty[tg] > 0
    cc = same.sum(1)
    z = lambda v: np.where(has_c, v, 0.0)
    out[:, F["c_share"]] = z(cc / n) if n else 0.0
    out[:, F["c_pos"]] = z(((POS * same).sum(1) + K * u_pos) / ((LABM * same).sum(1) + K) - u_pos)
    out[:, F["c_comp"]] = z(((comp[None, :] * same).sum(1) + K * u_comp) / (cc + K) - u_comp)
    scodes = {"": 0, "FINISHED": 1, "RELEASING": 2, "HIATUS": 3, "CANCELLED": 4}
    sst = np.array([scodes[e["series"]["status"]] for e in entries])
    same = (sst[None, :] == sst[tg, None]).astype(np.float64) * keep
    has_z = sst[tg] > 0
    zc = same.sum(1)
    zz = lambda v: np.where(has_z, v, 0.0)
    out[:, F["z_share"]] = zz(zc / n) if n else 0.0
    out[:, F["z_pos"]] = zz(((POS * same).sum(1) + K * u_pos) / ((LABM * same).sum(1) + K) - u_pos)
    out[:, F["z_comp"]] = zz(((comp[None, :] * same).sum(1) + K * u_comp) / (zc + K) - u_comp)
    names = sorted({x for e in entries for x in e["series"]["staff"]})
    if names:
        col = {x: i for i, x in enumerate(names)}
        SH = np.zeros((n_all, len(names)))
        for j, e in enumerate(entries):
            for x in e["series"]["staff"]:
                SH[j, col[x]] = 1.0
        share = ((SH[tg] @ SH.T) > 0).astype(np.float64) * keep                 # shares at least one person
        has_st = SH[tg].sum(1) > 0
        z = lambda v: np.where(has_st, v, 0.0)
        out[:, F["st_n"]] = z(np.log1p(share.sum(1)))
        out[:, F["st_pos"]] = z(((POS * share).sum(1) + K * u_pos) / ((LABM * share).sum(1) + K) - u_pos)
        out[:, F["st_has"]] = has_st.astype(np.float64)

    pop = np.array([_lg(e["series"]["pop"]) for e in entries])
    hp = np.array([1.0 if e["series"]["pop"] else 0.0 for e in entries])
    avg = np.array([(e["series"]["avg"] or 0) / 100.0 for e in entries])
    ha = np.array([1.0 if e["series"]["avg"] else 0.0 for e in entries])
    ch = np.array([_lg(e["series"]["chapters"]) for e in entries])
    hc = np.array([1.0 if e["series"]["chapters"] else 0.0 for e in entries]) * comp
    for name, sname, v, h, prior in (("pop_diff", "s_pop", pop, hp, C["pop0"]), ("avg_diff", "s_avg", avg, ha, C["avg0"]),
                                     ("ch_diff", "s_ch", ch, hc, C["ch0"])):
        tot = (v * h).sum() - v[tg] * h[tg]
        cn = h.sum() - h[tg]
        own = np.array([1.0 if x else 0.0 for x in ([s["pop"] for s in ser] if name == "pop_diff" else
                                                     [s["avg"] for s in ser] if name == "avg_diff" else [s["chapters"] for s in ser])])
        out[:, F[name]] = np.where(own > 0, out[:, F[sname]] - (tot + K * prior) / (cn + K), 0.0)
    return out


def ref_series_part(row, s, F):
    c, st = s["country"], s["status"]
    row[F["s_kr"]], row[F["s_jp"]], row[F["s_cn"]], row[F["s_has_country"]] = c == "KR", c == "JP", c == "CN", c != ""
    row[F["s_fin"]], row[F["s_rel"]], row[F["s_hia"]], row[F["s_can"]], row[F["s_has_status"]] = (
        st == "FINISHED", st == "RELEASING", st == "HIATUS", st == "CANCELLED", st != "")
    row[F["s_oneshot"]], row[F["s_has_format"]] = float(s["oneshot"] or 0), s["oneshot"] is not None
    row[F["s_ch"]], row[F["s_has_ch"]] = _lg(s["chapters"]), bool(s["chapters"])
    row[F["s_pop"]], row[F["s_has_pop"]] = _lg(s["pop"]), bool(s["pop"])
    row[F["s_avg"]], row[F["s_has_avg"]] = (s["avg"] or 0) / 100.0, bool(s["avg"])
    row[F["s_year"]], row[F["s_has_year"]] = ((s["year"] - 2000) / 10.0 if s["year"] else 0.0), bool(s["year"])
    row[F["s_ntags"]] = _lg(len(s["tags"]))
