"""
intent_augment.py - step 1 of the intent network: turn Kitsu's example messages into many
realistic variations, the way people actually type to a chat helper.

Input:  kitsunet/intents.jsonl          (written alongside web/js/kitsu.js: {"intent", "text"} per line)
        kitsunet/intent_extra.jsonl     (more examples written by hand in other voices, none close to a test message)
Output: <data>/intent/train.jsonl, val.jsonl

Examples are split 85 / 15 BEFORE augmenting, so no variation of a validation example is ever
trained on. Each training example then gets variations with:
  - series names swapped for other real titles (and their short forms: orv, tbate, sl...)
  - slang and short forms (wat, smth, rn, pls, rec, u, r, manwha / manhua...)
  - typos: swapped, dropped and doubled letters
  - casing (lower, Title, ALL CAPS, first letter)
  - filler words ("hey kitsu", "um", "so", "pls", "lol", "?")
The hand-written test messages in kitsunet/intent_heldout.jsonl are never augmented or trained on.

Run:   python kitsunet\\intent_augment.py
"""
import json
import random
import re
from collections import defaultdict

from common import DATA, HERE, MEDIA_DIR

OUT = DATA / "intent"
PER_INTENT = 700            # variations per intent in the training set (balanced classes)
VAL_SHARE = 0.15
SEED = 7

# Real titles people ask about (English names as the scan sites use them, plus short forms).
TITLES = [
    "Solo Leveling", "Omniscient Reader's Viewpoint", "The Beginning After the End", "Tower of God", "Lookism",
    "Eleceed", "Nano Machine", "Return of the Mount Hua Sect", "The Greatest Estate Developer", "Viral Hit",
    "Wind Breaker", "Pick Me Up", "Magic Emperor", "Damn Reincarnation", "Infinite Mage", "Overgeared",
    "The Breaker", "True Beauty", "Under the Oak Tree", "Remarried Empress", "Lout of Count's Family",
    "Trash of the Count's Family", "Mercenary Enrollment", "Villain to Kill", "Chainsaw Man", "Jujutsu Kaisen",
    "One Piece", "Berserk", "Vagabond", "Kingdom", "Blue Lock", "Spy x Family", "Frieren", "Dandadan",
    "Oshi no Ko", "Kagurabachi", "Sakamoto Days", "Martial Peak", "Tales of Demons and Gods", "Battle Through the Heavens",
    "Release That Witch", "Soul Land", "The S-Classes That I Raised", "Return of the Disaster-Class Hero",
    "Reaper of the Drifting Moon", "Legend of the Northern Blade", "The Boxer", "Weak Hero", "Questism",
    "Surviving Romance", "Who Made Me a Princess", "The Duke's Wife Obsession", "Doom Breaker", "Academy's Undercover Professor",
    "Regressor Instruction Manual", "Swordmaster's Youngest Son", "SSS-Class Suicide Hunter", "Sword Fanatic Wanders Through the Night",
    "A Returner's Magic Should Be Special", "Leveling With the Gods", "Second Life Ranker", "The Max Level Hero Has Returned",
    "Teenage Mercenary", "Study Group", "Get Schooled", "Hardcore Leveling Warrior", "Unordinary", "Noblesse",
    "God of High School", "Lore Olympus", "Seasons of Blossom", "Marry My Husband", "The Villainess Turns the Hourglass",
    "Death Is the Only Ending for the Villainess", "Kill the Villainess", "Your Throne", "Light and Shadow",
    "Raeliana", "Beware of the Villainess", "The Remarried Empress", "Hell's Paradise", "Mashle", "Bleach", "Naruto",
]
SHORT = ["orv", "tbate", "sl", "tog", "jjk", "rotmhs", "tged", "lotcf", "ssscsh", "nano", "mhs", "chainsaw", "op", "sssc"]

SLANG = [
    (r"\bwhat\b", ["wat", "wut", "whta"]), (r"\bwhats\b|\bwhat's\b", ["wats", "whats", "wuts"]),
    (r"\bsomething\b", ["smth", "sth", "somethin", "smthing"]), (r"\bright now\b", ["rn"]),
    (r"\bplease\b", ["pls", "plz", "pleasee"]), (r"\brecommend\b", ["rec", "recomend", "reccomend"]),
    (r"\brecommendations?\b", ["recs", "recos", "recomendations"]), (r"\bmanhwa\b", ["manwha", "manhua", "manhwas", "webtoon"]),
    (r"\bmanhua\b", ["manhwa", "manhuas"]), (r"\byou\b", ["u", "ya", "yu"]), (r"\bare\b", ["r"]), (r"\byour\b", ["ur", "yur"]),
    (r"\bthanks\b", ["thx", "thnx", "ty", "tysm"]), (r"\bwith\b", ["w/", "wit"]), (r"\bbecause\b", ["cuz", "bc"]),
    (r"\bdon't\b|\bdont\b", ["dont", "don't", "dnt"]), (r"\bi'm\b|\bim\b", ["im", "i'm", "ima"]),
    (r"\bchapters\b", ["chs", "chaps", "chapter"]), (r"\bchapter\b", ["ch", "chap", "chp"]), (r"\bto\b", ["2"]),
    (r"\bfor\b", ["4"]), (r"\bokay\b", ["ok", "k", "okk"]), (r"\bgoing to\b", ["gonna"]), (r"\bwant to\b", ["wanna"]),
    (r"\bgive me\b", ["gimme", "give me"]), (r"\blet me\b", ["lemme"]), (r"\bfavourites?\b|\bfavorites?\b", ["favs", "faves", "favorites"]),
    (r"\bseries\b", ["serie", "seris", "series"]), (r"\bthe\b", ["teh", "da", "the"]), (r"\bkitsu\b", ["kitsu", "kitsune", "kit"]),
]
PREFIX = ["hey kitsu ", "kitsu ", "um ", "so ", "ok ", "yo ", "hey ", "hmm ", "can you ", "could you ", "uh ", "btw ", "quick q ", "kitsu, "]
SUFFIX = [" pls", " please", "?", "??", " lol", " !", " rn", " thx", " kitsu", " haha", " :)", " ...", " now", " again"]
NO_FILLER = ("smalltalk_", "about_kitsu")        # fillers like "hey" or "thx" would change what these mean

KEYS = "qwertyuiop asdfghjkl zxcvbnm"


def typo(word, rng):
    if len(word) < 3 or not word.isalpha():
        return word
    i = rng.randrange(len(word) - 1)
    kind = rng.random()
    if kind < 0.3:
        return word[:i] + word[i + 1] + word[i] + word[i + 2:]                 # swap
    if kind < 0.6:
        return word[:i] + word[i + 1:]                                          # drop
    if kind < 0.8:
        return word[:i] + word[i] + word[i:]                                    # double
    row = next((r for r in KEYS.split() if word[i] in r), None)                 # neighbouring key
    if not row:
        return word
    j = row.index(word[i])
    return word[:i] + row[max(0, min(len(row) - 1, j + rng.choice([-1, 1])))] + word[i + 1:]


def load_titles():
    titles = list(TITLES)
    try:
        pop = []
        for p in MEDIA_DIR.glob("*.json"):
            for m in json.loads(p.read_text()).values():
                if m and m.get("popularity") and m.get("format") != "NOVEL":
                    name = (m.get("title") or {}).get("english") or (m.get("title") or {}).get("romaji")
                    if name and len(name) < 45 and re.fullmatch(r"[\x20-\x7e]+", name):
                        pop.append((m["popularity"], name))
        titles += [n for _, n in sorted(pop, reverse=True)[:400]]
    except FileNotFoundError:
        pass
    return sorted(set(titles), key=str.lower)


def title_pattern(titles):
    names = sorted(set(titles) | set(SHORT), key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(re.escape(n) for n in names) + r")\b", re.I)


def vary(text, intent, rng, titles, pat):
    t = text
    if pat.search(t) and rng.random() < 0.8:
        def swap(_):
            name = rng.choice(SHORT) if rng.random() < 0.12 else rng.choice(titles)
            return name.lower() if rng.random() < 0.5 else name
        t = pat.sub(swap, t)
    for rx, alts in SLANG:
        if rng.random() < 0.35:
            t = re.sub(rx, lambda m: rng.choice(alts), t, flags=re.I)
    words = t.split(" ")
    if len(words) >= 4 and rng.random() < 0.2:                                 # people leave words out
        del words[rng.randrange(1, len(words))]
    rate = rng.choice([0, 0, 0.05, 0.1, 0.15, 0.25])
    words = [typo(w, rng) if rng.random() < rate else w for w in words]
    t = " ".join(words)
    if not intent.startswith(NO_FILLER):
        if rng.random() < 0.25:
            t = rng.choice(PREFIX) + t
        if rng.random() < 0.25:
            t = t.rstrip("?!. ") + rng.choice(SUFFIX)
    else:
        if rng.random() < 0.2:
            t = t + rng.choice(["!", "!!", " :)", "~", "."])
    c = rng.random()
    if c < 0.45:
        t = t.lower()
    elif c < 0.6:
        t = t[:1].upper() + t[1:]
    elif c < 0.66:
        t = t.title()
    elif c < 0.69:
        t = t.upper()
    if rng.random() < 0.15:
        t = t.rstrip("?!. ")
    return t


def main():
    rng = random.Random(SEED)
    by = defaultdict(list)
    lines = (HERE / "intents.jsonl").read_text(encoding="utf-8").splitlines()
    lines += (HERE / "intent_extra.jsonl").read_text(encoding="utf-8").splitlines()     # extra hand-written examples
    for line in lines:
        if line.strip():
            j = json.loads(line)
            if j["text"].strip() not in by[j["intent"]]:
                by[j["intent"]].append(j["text"].strip())
    titles = load_titles()
    pat = title_pattern(titles)
    OUT.mkdir(parents=True, exist_ok=True)
    train, val = [], []
    for intent in sorted(by):
        texts = sorted(by[intent])
        rng.shuffle(texts)
        k = max(2, int(round(len(texts) * VAL_SHARE)))
        v, tr = texts[:k], texts[k:]
        val += [{"intent": intent, "text": t} for t in v]                     # validation: originals plus two variations each
        val += [{"intent": intent, "text": vary(t, intent, rng, titles, pat)} for t in v for _ in range(2)]
        rows = [{"intent": intent, "text": t} for t in tr]                    # the originals, once each
        while len(rows) < PER_INTENT:
            rows.append({"intent": intent, "text": vary(rng.choice(tr), intent, rng, titles, pat)})
        train += rows
    rng.shuffle(train)
    with open(OUT / "train.jsonl", "w", encoding="utf-8", newline="\n") as f:
        f.writelines(json.dumps(r) + "\n" for r in train)
    with open(OUT / "val.jsonl", "w", encoding="utf-8", newline="\n") as f:
        f.writelines(json.dumps(r) + "\n" for r in val)
    meta = {"intents": sorted(by), "examples": sum(len(v) for v in by.values()), "train": len(train), "val": len(val),
            "titles": len(titles)}
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print(meta)
    for r in train[:12]:
        print(" ", r["intent"], "|", r["text"])


if __name__ == "__main__":
    main()
