"""Build Folio's offline autocomplete from a checksum-pinned ffdkj snapshot."""

import argparse
import hashlib
import json
import re
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path
from urllib.request import urlopen


CATALOG = Path(__file__).resolve().parents[1] / "public" / "catalog-data"
REPOSITORY = "ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table"
REVISION = "15f5f4b50428226649d371cbf7faff8ddaacdb24"
SNAPSHOT_DATE = "2026-11-09"
CHECKSUMS = {
    "tag.sqlite": "17305abac098be0c3a268e4bfd676711de4a7690529bdb14d0a6be22ce4a2c35",
    "LICENSE": "014b110a69780163b0a0a2ed87465d950dc3841694342115aab0db49fc2f3ccc",
}
# In face tags the underscore is the mouth, not a word separator.
FACE = re.compile(r"(?:._.|<[^<>]+>_<[^<>]+>)")


def source_file(name, source_dir):
    if source_dir:
        data = (source_dir / name).read_bytes()
    else:
        url = f"https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}/{name}"
        with urlopen(url, timeout=90) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != CHECKSUMS[name]:
        raise ValueError(f"Checksum mismatch for {name} at {REVISION}")
    return data


def catalog_aliases():
    result = {}
    for filename, category in [("artist", 1), ("character", 4)]:
        rows = json.loads((CATALOG / f"{filename}.json").read_bytes())
        for row in rows:
            if len(row) <= 8 or not row[8]:
                continue
            key = row[0].replace("_", " ").strip().lower()
            names = [name.strip().replace("_", " ").lower() for name in row[8].split("|")]
            result[(category, key)] = "|".join(dict.fromkeys(name for name in names if name and name != key))
    return result


def build(database):
    aliases = catalog_aliases()
    categories = Counter()
    alias_count = 0
    rows = []
    keys = set()
    connection = sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        for raw, zh, category, count in connection.execute(
            "SELECT name, cn_name, category, post_count FROM tags ORDER BY post_count DESC, name ASC"
        ):
            if not raw or not zh.strip() or category not in (0, 1, 3, 4, 5) or count < 0:
                raise ValueError(f"Invalid tag row: {raw!r}")
            key = raw if category == 0 and FACE.fullmatch(raw) else raw.replace("_", " ")
            if key in keys:
                raise ValueError(f"Duplicate Folio tag key: {key!r}")
            keys.add(key)
            row = [key, zh.strip(), category, count]
            extra = aliases.get((category, key))
            if extra:
                row.append(extra)
                alias_count += len(extra.split("|"))
            rows.append(row)
            categories[category] += 1
    finally:
        connection.close()
    return rows, dict(sorted(categories.items())), alias_count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Read tag.sqlite and LICENSE from a local snapshot")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(dir=CATALOG, prefix=".ffdkj-") as directory:
        staging = Path(directory)
        database = staging / "tag.sqlite"
        database.write_bytes(source_file("tag.sqlite", args.source_dir))
        license_text = source_file("LICENSE", args.source_dir)
        rows, categories, alias_count = build(database)
        previous = json.loads((CATALOG / "manifest.json").read_bytes())
        metadata = {
            "tags": len(rows),
            "artists": previous["artists"],
            "characters": previous["characters"],
            "aliases": alias_count,
            "source": REPOSITORY,
            "version": SNAPSHOT_DATE.replace("-", "."),
            "tagCategories": categories,
            "tagSource": {
                "repository": f"https://github.com/{REPOSITORY}",
                "revision": REVISION,
                "date": SNAPSHOT_DATE,
                "sha256": CHECKSUMS["tag.sqlite"],
                "license": "MIT",
                "aliasSource": "Matching artist and character records from the bundled Folio catalog",
            },
            "catalogSource": previous.get("catalogSource") or {
                "source": previous["source"], "version": previous["version"]
            },
        }
        with (staging / "tags.json").open("w", encoding="utf-8", newline="\n") as output:
            json.dump(rows, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        (staging / "manifest.json").write_bytes(
            (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        )
        (staging / "ffdkj-LICENSE.txt").write_bytes(license_text)
        for name in ("ffdkj-LICENSE.txt", "tags.json", "manifest.json"):
            (staging / name).replace(CATALOG / name)
    print(f"{len(rows):,} tags, categories {categories}, {alias_count:,} supplemental aliases")


if __name__ == "__main__":
    main()
