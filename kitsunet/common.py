"""common.py - paths and the user split shared by every KitsuNet step."""
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
WEB_OUT = REPO / "web" / "kitsunet"            # what the app loads

DATA = Path(r"C:\Users\Admin\koru-nn-data")    # outside the repo: downloads, prepared arrays, runs
RAW = DATA / "anilist"
USERS_DIR = RAW / "users"
MEDIA_DIR = RAW / "media"
PREPARED = DATA / "prepared"
RUNS = DATA / "runs"

SPLIT_SEED = 20261125


def split_users(users):
    """80% of readers to learn from, 10% to tune on, 10% kept back for the final exam."""
    rng = np.random.default_rng(SPLIT_SEED)
    shuffled = rng.permutation(np.sort(np.asarray(users)))
    a, b = int(len(shuffled) * 0.8), int(len(shuffled) * 0.9)
    return {"train": set(shuffled[:a].tolist()), "val": set(shuffled[a:b].tolist()), "test": set(shuffled[b:].tolist())}
