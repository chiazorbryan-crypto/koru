"""
fetch.py - step 1 of the taste network: download real public manga lists from AniList.

AniList's GraphQL API (https://graphql.anilist.co) needs no key. It allows about 30 requests a
minute at the moment (the X-RateLimit-Limit header says so), so this script waits between
requests, backs off on 429 using Retry-After, and caches every answer on disk. Running it again
only asks for what is missing.

  1. readers: user ids come from AniList's public feed of manga list updates (who is reading now)
  2. lists:   each reader's MediaListCollection (type MANGA); private lists are skipped
  3. series:  metadata for every series on those lists, 50 per request, most common first

Run:   python kitsunet\\fetch.py [users_wanted]
"""
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request

from common import MEDIA_DIR, RAW, USERS_DIR

URL = "https://graphql.anilist.co"
MIN_GAP = 2.4                     # seconds between requests (about 25 a minute: AniList allows 30)
MIN_ENTRIES = 15                  # lists shorter than this teach little

FEED_Q = """query($p:Int,$before:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
 activities(type:MANGA_LIST,createdAt_lesser:$before,sort:ID_DESC){... on ListActivity{userId}}}}"""
FEED_PAGES = 25                   # AniList pages stop at 5,000 rows, so the feed is read in one-day windows
LIST_Q = """query($id:Int){MediaListCollection(userId:$id,type:MANGA){hasNextChunk
 user{id mediaListOptions{scoreFormat}}
 lists{isCustomList entries{mediaId status score(format:POINT_100) progress repeat updatedAt}}}}"""
MEDIA_Q = """query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:MANGA){id title{romaji english}
 genres tags{name rank isMediaSpoiler} countryOfOrigin format status chapters volumes averageScore popularity
 startDate{year} staff(perPage:6,sort:RELEVANCE){edges{role node{id name{full}}}}}}}"""

_last = [0.0]
_lock = threading.Lock()
WORKERS = 3                       # big lists take seconds to arrive, so a few are in flight at once (still 30 a minute)


def ask(query, variables, tries=8):
    """One GraphQL request, politely spaced, with backoff. Returns (data, errors)."""
    body = json.dumps({"query": query, "variables": variables}).encode()
    for attempt in range(tries):
        with _lock:                                   # requests START at least MIN_GAP apart, across threads
            wait = _last[0] + MIN_GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        req = urllib.request.Request(URL, data=body, headers={
            "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "kitsunet-trainer/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read())
                return j.get("data"), j.get("errors")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code == 429:
                pause = int(e.headers.get("Retry-After") or 60) + 1
                print(f"  429, waiting {pause}s", flush=True)
                time.sleep(pause)
                continue
            try:
                j = json.loads(text)
            except ValueError:
                j = None
            if j and j.get("errors") and e.code in (400, 404):
                return j.get("data"), j["errors"]          # e.g. "Private User", "Not Found"
            print(f"  HTTP {e.code}, retry {attempt + 1}", flush=True)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            print(f"  network error {e!r}, retry {attempt + 1}", flush=True)
        time.sleep(min(120, 5 * 2 ** attempt))
    raise RuntimeError("AniList kept failing")


def feed_users(wanted):
    """Readers from the public feed of manga list updates, one day window at a time going back."""
    path = RAW / "feed_users.json"
    state = json.loads(path.read_text()) if path.exists() else {}
    if isinstance(state, list):
        state = {"users": state, "window": 0, "start": int(time.time())}
    users, seen = state.setdefault("users", []), set(state["users"])
    state.setdefault("start", int(time.time()))
    while len(users) < wanted and state.setdefault("window", 0) < 400:
        before = state["start"] - state["window"] * 86400
        for page in range(1, FEED_PAGES + 1):
            data, err = ask(FEED_Q, {"p": page, "before": before})
            acts = (((data or {}).get("Page") or {}).get("activities")) or []
            for a in acts:
                u = a.get("userId") if a else None
                if u and u not in seen:
                    seen.add(u)
                    users.append(u)
            if not acts:
                break
        state["window"] += 1
        path.write_text(json.dumps(state))
        print(f"feed window {state['window']}: {len(users)} readers", flush=True)
    path.write_text(json.dumps(state))
    return users


def fetch_list(u):
    path = USERS_DIR / f"{u}.json"
    if path.exists():
        return json.loads(path.read_text())
    data, err = ask(LIST_Q, {"id": u})
    coll = (data or {}).get("MediaListCollection")
    if not coll:
        j = {"error": (err or [{}])[0].get("message", "no list")}
    else:
        seen, entries = set(), []
        for lst in coll.get("lists") or []:
            if lst.get("isCustomList"):
                continue                              # custom lists repeat entries from the status lists
            for e in lst.get("entries") or []:
                if e["mediaId"] not in seen:
                    seen.add(e["mediaId"])
                    entries.append(e)
        j = {"user": u, "scoreFormat": (coll.get("user") or {}).get("mediaListOptions", {}).get("scoreFormat"),
             "chunked": bool(coll.get("hasNextChunk")), "entries": entries}
    path.write_text(json.dumps(j, separators=(",", ":")))
    return j


def fetch_lists(users, wanted):
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    good, asked = 0, 0
    with ThreadPoolExecutor(WORKERS) as pool:
        for at in range(0, len(users), 30):
            for j in pool.map(fetch_list, users[at:at + 30]):
                asked += 1
                if len(j.get("entries") or []) >= MIN_ENTRIES:
                    good += 1
            print(f"lists: {asked}/{len(users)} asked, {good} usable", flush=True)
            if good >= wanted:
                break
    return good


def fetch_media():
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    count = {}
    for p in USERS_DIR.glob("*.json"):
        for e in json.loads(p.read_text()).get("entries") or []:
            if e["status"] != "PLANNING":                # planned-only series are never used
                count[e["mediaId"]] = count.get(e["mediaId"], 0) + 1
    have = set()
    for p in MEDIA_DIR.glob("*.json"):
        have.update(int(k) for k in json.loads(p.read_text()))
    need = [m for m, _ in sorted(count.items(), key=lambda kv: -kv[1]) if m not in have]
    print(f"series: {len(count)} on lists, {len(have)} cached, {len(need)} to ask", flush=True)
    first = len(list(MEDIA_DIR.glob("*.json")))
    jobs = [(first + k, need[i:i + 50]) for k, i in enumerate(range(0, len(need), 50))]

    def one(job):
        no, ids = job
        data, err = ask(MEDIA_Q, {"ids": ids})
        got = {m["id"]: m for m in ((data or {}).get("Page") or {}).get("media") or []}
        for m in ids:                                    # remember misses too, so they are not asked again
            got.setdefault(m, None)
        (MEDIA_DIR / f"b{no:05d}.json").write_text(json.dumps(got, separators=(",", ":")))
        return len(ids)

    done = 0
    with ThreadPoolExecutor(WORKERS) as pool:
        for k, n in enumerate(pool.map(one, jobs)):
            done += n
            if k % 20 == 0:
                print(f"series: {done}/{len(need)}", flush=True)


def main(wanted):
    RAW.mkdir(parents=True, exist_ok=True)
    users = feed_users(int(wanted * 1.6))
    print(f"{len(users)} readers from the feed", flush=True)
    good = fetch_lists(users, wanted)
    if good < wanted:
        users = feed_users(int(len(users) * wanted / max(good, 1) * 1.15))
        good = fetch_lists(users, wanted)
    print(f"{good} usable lists", flush=True)
    fetch_media()
    print("done", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "media":      # series metadata for the lists fetched so far
        fetch_media()
    else:
        main(int(sys.argv[1]) if len(sys.argv) > 1 else 3000)
