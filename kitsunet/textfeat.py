"""
textfeat.py - how the intent network reads a message. web/js/kitsunet.js copies this exactly.

  1. tidy:   lower case; curly quotes become straight; apostrophes vanish ("what's" -> "whats");
             "?" becomes its own word; anything that isn't a-z, 0-9 or "?" becomes a space.
  2. pieces: every word ("w:" + word), every pair of neighbouring words ("b:" + w1 + " " + w2),
             and the 3, 4 and 5 letter runs of "<word>" ("c:" + run). The letter runs are what
             let the network read typos: "recomend" still shares most runs with "recommend".
  3. hash:   each piece goes through 32-bit FNV-1a (over its UTF-8 bytes) into one of BUCKETS rows.
"""
import re

MIN_N, MAX_N = 3, 5
MAX_WORDS = 40                     # longer messages are cut (nobody types more to a chat helper)

_strip = re.compile(r"[^a-z0-9?]+")


def tidy(text):
    t = str(text).lower().replace("’", "'").replace("‘", "'").replace("'", "").replace("`", "")
    t = t.replace("?", " ? ")
    t = _strip.sub(" ", t)
    return t.split()[:MAX_WORDS]


def pieces(text):
    words = tidy(text)
    out = []
    for i, w in enumerate(words):
        out.append("w:" + w)
        if i:
            out.append("b:" + words[i - 1] + " " + w)
        if w == "?":
            continue
        m = "<" + w + ">"
        for n in range(MIN_N, MAX_N + 1):
            for a in range(0, len(m) - n + 1):
                out.append("c:" + m[a:a + n])
    return out


def fnv1a(s):
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def ids(text, buckets):
    """Bucket numbers for a message (repeats kept: a piece that appears twice counts twice)."""
    return [fnv1a(p) % buckets for p in pieces(text)]
