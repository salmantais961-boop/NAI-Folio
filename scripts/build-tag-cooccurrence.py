"""Build a compact, offline tag-pair index from a pinned Danbooru count snapshot."""

import argparse
import csv
import hashlib
import heapq
import json
import math
import shutil
import tempfile
from collections import defaultdict
from pathlib import Path
from urllib.request import urlopen

CATALOG = Path(__file__).resolve().parents[1] / "public" / "catalog-data"
SOURCE = "https://huggingface.co/datasets/newtextdoc1111/danbooru-tag-csv"
REVISION = "fdf2772213f13d46bff60fc5ebd876e1a811a053"
FREQUENCIES = "danbooru_tags.csv"
PAIRS = "danbooru_tags_cooccurrence.csv"
CHECKSUMS = {
    FREQUENCIES: "a48e1e63b81e8e4fc3091c660fd763e9d05e19beea3b98d1ee78d00ed10ac9d3",
    PAIRS: "29bf95d3dd2f4b1038ac26b3fee371ebbe67d9b622b32d274c9486dbde56077a",
}
PER_TAG = 48
SUPPORT_PRIOR = 100


def verified_input(name, source_dir, temporary):
    if source_dir is None:
        file = temporary / name
        with urlopen(f"{SOURCE}/resolve/{REVISION}/{name}", timeout=150) as remote, file.open("wb") as dest:
            shutil.copyfileobj(remote, dest)
    else:
        file = source_dir / name
    digest = hashlib.sha256()
    with file.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != CHECKSUMS[name]:
        raise ValueError(f"{name} checksum does not match pinned snapshot {REVISION}")
    return file


def shard_key(name):
    value = 2166136261
    for char in name:
        value = ((value ^ ord(char)) * 16777619) & 0xffffffff
    return f"{value & 15:02x}"


def build(source_dir, temporary):
    # Join by upstream English spelling; keep the Folio spelling for the client,
    # including literal underscores in kaomoji.
    rows = json.loads((CATALOG / "tags.json").read_bytes())
    dictionary = {row[0].replace(" ", "_"): (row[0], row[2]) for row in rows}
    if len(dictionary) != len(rows):
        raise ValueError("The active dictionary has ambiguous English tag names")
    del rows

    marginal = verified_input(FREQUENCIES, source_dir, temporary)
    names = {}
    with marginal.open(encoding="utf-8", newline="") as file:
        for row in csv.DictReader(file):
            item = dictionary.get(row["tag"])
            if item and int(row["count"]) > 0:
                names[row["tag"]] = (*item, int(row["count"]))
    del dictionary

    # For a fixed seed its frequency factor in cosine similarity is constant.
    # A support prior damps high similarities arising from fewer observations.
    neighbours = defaultdict(list)
    def retain(seed, candidate, count):
        key, category, frequency = candidate
        score = count / math.sqrt(frequency) * count / (count + SUPPORT_PRIOR)
        item = (category == 0, score, count, key)
        heap = neighbours[seed]
        if len(heap) < PER_TAG:
            heapq.heappush(heap, item)
        elif item > heap[0]:
            heapq.heapreplace(heap, item)

    pairs = verified_input(PAIRS, source_dir, temporary)
    total = accepted = 0
    minimum = None
    with pairs.open(encoding="utf-8", newline="") as file:
        for row in csv.DictReader(file):
            total += 1
            raw_count = float(row["count"])
            if not raw_count.is_integer() or raw_count < 1:
                raise ValueError("Invalid pair count")
            count = int(raw_count)
            minimum = count if minimum is None else min(minimum, count)
            a, b = names.get(row["tag_a"]), names.get(row["tag_b"])
            if not a or not b:
                continue
            if a == b or count > min(a[2], b[2]):
                raise ValueError(f"Inconsistent source totals for {a[0]} and {b[0]}")
            retain(a[0], b, count)
            retain(b[0], a, count)
            accepted += 1

    totals = {key: count for key, _, count in names.values()}
    shards = {f"{n:02x}": {} for n in range(16)}
    for seed in sorted(neighbours):
        ranked = [[key, count] for _, _, count, key in sorted(neighbours[seed], reverse=True)]
        shards[shard_key(seed)][seed] = [totals[seed], ranked]
    dest = CATALOG / "cooccurrence"
    dest.mkdir(exist_ok=True)
    info = {
        "source": SOURCE,
        "revision": REVISION,
        "sourceRevisionDate": "2025-05-15",
        "pairFilePublished": "2025-05-09",
        "license": "MIT",
        "inputSha256": CHECKSUMS,
        "unit": "Shared Danbooru posts in the source snapshot; not prompt order or Folio usage.",
        "inputPairs": total,
        "minimumInputPairCount": minimum,
        "matchedPairs": accepted,
        "coveredSeeds": len(neighbours),
        "maxNeighbours": PER_TAG,
        "shards": len(shards),
        "ranking": "General tags first, then cosine similarity times joint / (joint + 100), then joint count.",
    }
    for name, contents in shards.items():
        p = temporary / f"{name}.json"
        p.write_bytes((json.dumps(contents, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
    (temporary / "manifest.json").write_bytes((json.dumps(info, indent=2) + "\n").encode())
    for name in [*shards, "manifest"]:
        (temporary / f"{name}.json").replace(dest / f"{name}.json")
    print(f"{accepted:,}/{total:,} source pairs matched, {len(neighbours):,} covered tags in {len(shards)} shards")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Read the two pinned CSV files from disk")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(dir=CATALOG, prefix=".cooccurrence-") as temp:
        build(args.source_dir, Path(temp))
