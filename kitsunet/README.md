# KitsuNet: the two small networks behind Kitsu

Kitsu, Koru's assistant, uses two tiny neural networks trained here. Both run inside the app in
plain JavaScript (`web/js/kitsunet.js`), offline, from two JSON files in `web/kitsunet/`, and
load only the first time Kitsu needs them.

| Network | Answers | Learns from | File |
|---|---|---|---|
| **intent** | What is this chat message asking for? (44 intents) | Kitsu's example messages, augmented | `web/kitsunet/intent.json` |
| **taste** | Will this reader finish and enjoy this series? (0..1) | Real public AniList manga lists | `web/kitsunet/taste.json` |

The method copies Glasswave's skipnet: readers split into train / validation / test, a simple
baseline to beat, a small search over shapes, one final exam on data never used before, an
export of scaling + weights + constants to JSON, and a golden file that proves the app's
JavaScript reproduces the training maths (`node kitsunet/check.mjs`, tolerance 1e-5).

## Results (in the app now)

**Intent** (`i-8k-32-pd`: 8,192 hashed rows x 32, average, softmax over 44 intents; 263,596 weights,
`intent.json` 442 KB with the int8 table). Trained on 2,184 examples (`intents.jsonl` 1,996 +
`intent_extra.jsonl` 188 written by hand) grown to 30,800 variations.

| Method | Validation | Final exam (`intent_exam.jsonl`, 126 hand-written) |
|---|---|---|
| Whole words only + softmax | 86.1% | 81.7% |
| **The network** (letter runs, word pairs, pieces dropped at random while training) | **96.0%** | **87.3%** (top 3: 92.9%) |

The first hand-written set, `intent_heldout.jsonl` (145), scored 69.0% with the first network
(63.4% words-only). Its mistakes showed the examples were too templated, which led to
`intent_extra.jsonl` (none within 0.6 word overlap of a test message) and the piece dropout, so it
is no longer a clean test: it now scores 78.6%. `intent_exam.jsonl` was written before those changes
and used once. Typical mistakes left: "do you know any jokes" -> capabilities, "can i read without
internet" -> incognito help, "what should i read after finishing omniscient reader" -> recommend
(instead of more_like), "got anything else?" -> refine_not_that. Validation scores far above the
exams: Kitsu's examples are close to each other, so treat ~87% as the honest number, and use the
second choice when the first is unsure. Hidden layers, bigger tables and label smoothing did not
help on validation.

**Taste** (`final-64-32-s0`: 53 inputs, hidden layers of 64 and 32; 5,569 weights, `taste.json` 73 KB).
Data: 1,664 AniList readers (out of 1,936 public lists downloaded; the rest were short, or the
metadata download stopped before their series were all in), 439,975 started entries, 27,839
series. Labelled rows: 88,283 train (1,331 readers), 23,029 validation (166), 23,674 test (167,
over three views).

Final exam on the 167 test readers:

| View | Always "yes" | Their hit rate | Logistic regression | **Network** |
|---|---|---|---|---|
| full metadata | 68.1% / AUC 0.50 | AUC 0.767 | 81.1% / AUC 0.865 | **81.5% / AUC 0.873** |
| Koru-like metadata | 68.3% | AUC 0.767 | 78.9% / AUC 0.817 | **79.1% / AUC 0.826** |
| small profiles (5-80 series) | 74.6% | AUC 0.714 | 78.3% / AUC 0.761 | **79.8% / AUC 0.778** |

(accuracy / AUC). AniList's average score alone ranks at AUC 0.648. By country (full view):
KR 0.873, JP 0.867, CN 0.851. Calibration is good (average gap 0.8-3 points). Inside one reader's
own list (ranking for one person) the AUC is 0.76 with full metadata and 0.61 Koru-like, so most of
the edge comes from knowing the reader's habits plus the series's status and genres; the ranking of
two similar series for the same reader is only modestly better than chance on Koru's data alone.
Shapes from 32 to 128-64-32 scored within 0.003 of each other on validation; the smallest within
0.001 of the best was kept. Hiding one group of inputs costs (validation log loss, 6-epoch runs):
reader 0.041, compared-with-usual 0.013, genres/tags 0.009, same status 0.007, country/people
0.005, series 0.004.

**App.** `node kitsunet/check.mjs`: 90 intent messages and 88 series over 10 readers (6 real test
readers, 3 made-up Koru libraries with scan-site genre names and Kitsu cards, one empty) match
Python to 5e-10 (intent) and 9e-8 (taste chance); the inputs match to 4e-8 (golden values are rounded
to 10 digits). In node: about 80 µs per message and 55 µs per series.

## The intent network

**Input.** A message is tidied (lower case, apostrophes dropped, `?` kept as a word, everything
else that isn't a-z or 0-9 becomes a space) and cut into pieces: each word, each pair of
neighbouring words, and every 3, 4 and 5 letter run of `<word>`. The letter runs are what let it
read typos: "recomend" shares most of its runs with "recommend". Each piece is hashed (32-bit
FNV-1a) into one row of an embedding table; the rows are averaged and a softmax layer scores the
intents. `textfeat.py` is the reference; `kitsunet.js` has the same code.

**Data.** `kitsunet/intents.jsonl`, written next to `web/js/kitsu.js`: one `{"intent", "text"}`
per line. Before augmenting, 15% of the examples of every intent are held back for validation
(with two variations each, but only of themselves). The rest get variations up to 700 per intent
(`intent_augment.py`):

- series names swapped for other real titles (about 450: popular AniList titles plus a hand list) and short forms (orv, tbate, jjk...)
- slang and short forms: wat, smth, rn, pls, rec, u, r, ur, thx, chs, manwha / manhua / webtoon...
- typos: swapped, dropped and doubled letters, a neighbouring key
- a word left out, casing (lower, Title, ALL CAPS), filler words ("hey kitsu", "um", "pls", "lol", "?")

**Final exam.** `kitsunet/intent_exam.jsonl` (see Results for `intent_heldout.jsonl`): messages written by hand for this, in a
different voice from the examples, never augmented and never trained on (checked: none is an
exact copy of an example after tidying).

**Size.** The embedding table is stored as int8 per row (row = q x scale) in base64; the softmax
layer as plain numbers. The export checks the int8 table still picks the same intent as the
trained network.

## The taste network

**Data.** [AniList](https://anilist.co)'s public GraphQL API (no key). `fetch.py` takes readers
from the public feed of manga list updates (one-day windows going back, since a page stops at
5,000 rows), downloads each one's MediaListCollection (type MANGA; private lists are skipped), then
the metadata of every series on those lists (genres, tags with ranks, country, format, status,
chapters, average score, popularity, start year, the first six staff). It keeps to AniList's
current limit (30 requests a minute; it aims for about 25), backs off on 429 with Retry-After and
caches every answer on disk, so a rerun asks only for what is missing.

**What it predicts.** For each series a reader started (PLANNING is left out everywhere; novels
too, since Koru reads comics), with m = the reader's mean score:

| Entry | Label |
|---|---|
| DROPPED | 0 |
| scored at or above m | 1 |
| scored 10+ points below m (on the 100 scale) | 0 |
| COMPLETED or REPEATING otherwise | 1 |
| anything else (reading, unscored) | left out |

**Inputs (53 numbers), all from the reader's OTHER entries** (the series is left out of its own
profile, so nothing leaks) plus the series's own metadata. `taste_features.py` documents them and
holds two versions: a simple reference that `kitsunet.js` copies, and a fast matrix version for
training; `check_taste.py` proves they agree.

| Group | Inputs |
|---|---|
| The reader | list length, completion rate, drop rate, hit rate (share of labelled entries that are 1), share labelled, share scored, mean score (all smoothed toward everyone's rates by 5 entries) |
| The series | country (KR / JP / CN) and status (finished / releasing / hiatus / cancelled) one-hot, one-shot, log chapters, log popularity, average score, start year, number of tags; each with a "known" flag |
| Genres, then tags | how much of the reader's list has them, their hit / completion / drop rate on them (pooled, and the best and worst single one) compared with their overall rate |
| Top tags | overlap with the reader's 10 most-read tags, and their 10 most-enjoyed |
| Country, people | share of the list from the same country and their hit / completion rate there; how many entries share a staff member and the hit rate on those |
| Compared | popularity, average score and length against the reader's usual |
| Same status | share of the list with the same publishing status (finished / releasing...) and their hit / completion rate on those |

A series's tags are its AniList genres plus tags ranked 60 or more that aren't spoilers, so they
look like a scan site's genre list. Koru maps a site's genre names onto these (lower case, letters
and digits only, plus a small table such as murim -> Martial Arts, regression -> Age Regression,
school life -> School; `taste_export.py` ALIASES).

**What Koru knows.** Koru usually has a site's genre list, status, author and chapter count, but
no popularity, score, year or format. So the readers are seen three ways (`taste_prepare.py`):

- **full**: all AniList metadata
- **koru**: genres plus the 4 highest-ranked tags (none at all for a quarter of series, as Koru only
  knows genres of pages it has seen); no popularity, score, year or format; chapters,
  country and people each sometimes missing
- **small**: a "fresh start", 5 to 80 random series of the list, with koru metadata (a new install)

Training readers get one full-or-koru view each, and 40% also a small one. Validation and test
readers get all three, reported separately.

**In the app.** `K.kitsuNet.profileFrom(K.data)` turns Koru's data into the same kind of profile:

| Koru | Profile |
|---|---|
| started = history, read marks, reading time, completed / trash mark, rating, like, or a status shelf | the entry is used; a favourite never opened counts as planning and is left out |
| Absolute trash, or a shelf whose name has "drop" | DROPPED |
| Mark as completed, or a "completed" / "finished" shelf | COMPLETED |
| a "reread" shelf | REPEATING |
| anything else read | CURRENT |
| your stars (1-5) | score x 20; a like without stars counts as 90 |
| genres | the series pages Koru has seen (Discover's `koru-disc-tags` cache), or `data.tags`, plus `data.series[key]` when given |

Privacy flags found in Koru: **Hide** (`K.data.flags[key].hidden`) is the only per-series private
mark, so hidden series are left out unless `includePrivate` is set. **Incognito** is a global switch
under which Koru saves nothing (no history, read marks or stats), so there is nothing of it to
leave out. Notes are private text and are never read. Trash is not private: it is the reader's
strongest "no", and counts as dropped.

## Rebuilding

Run with the Python environment that has torch (`C:\Users\Admin\glasswave-nn-data\venv`; only run,
nothing installed into it). Data and runs live in `C:\Users\Admin\koru-nn-data`, outside the repo.

```powershell
cd C:\Users\Admin\Projects\Koru\kitsunet
$py = "C:\Users\Admin\glasswave-nn-data\venv\Scripts\python.exe"
```

Intent network:

```powershell
& $py intent_augment.py            # variations of intents.jsonl -> koru-nn-data\intent
& $py intent_train.py base         # words only + softmax: the bar to beat
& $py intent_train.py search       # table sizes and shapes, judged on validation
& $py intent_train.py exam         # the hand-written messages, once
& $py intent_train.py export       # web\kitsunet\intent.json + golden.json (intent part)
```

Taste network:

```powershell
& $py fetch.py 3000                # AniList lists and series metadata (hours; resumable; stop any time)
& $py fetch.py media               # metadata for the lists so far (most common series first)
& $py taste_prepare.py             # inputs for every labelled entry, three views
& $py check_taste.py 40            # fast features == reference features
& $py taste_train.py base          # logistic regression: the bar to beat
& $py taste_train.py explore       # 5 shapes
& $py taste_train.py groups        # what each group of inputs is worth
& $py taste_train.py final         # the chosen shape from two random starts
& $py taste_evaluate.py final-...  # the final exam on the test readers
& $py taste_export.py final-...    # web\kitsunet\taste.json + golden.json (taste part)
```

Then, from the repo root:

```powershell
node kitsunet\check.mjs
```

## Files

| File | What it does |
|---|---|
| `common.py` | Paths and the reader split |
| `textfeat.py` | How the intent network reads a message (the app copies it) |
| `intent_augment.py` | Variations of the example messages |
| `intent_train.py` | Intent baseline, search, final exam, export |
| `intent_exam.jsonl`, `intent_heldout.jsonl` | Hand-written test messages (final exam, first exam) |
| `intent_extra.jsonl` | Extra hand-written training examples |
| `fetch.py` | Downloads AniList lists and series metadata, politely, with a disk cache |
| `taste_features.py` | The 53 taste inputs: reference version and fast version |
| `taste_prepare.py` | Builds the taste inputs for every split and view |
| `check_taste.py` | Proves the two feature versions agree |
| `taste_train.py` | Trains taste networks: base, explore, groups, final |
| `taste_evaluate.py` | The taste final exam |
| `taste_export.py` | Writes taste.json and the taste golden cases |
| `metrics.py` | Log loss, AUC, accuracy, calibration |
| `check.mjs` | Runs golden.json through `web/js/kitsunet.js` and times it |
