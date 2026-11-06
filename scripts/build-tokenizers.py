"""Rebuild Folio's browser vocabularies from checksum-pinned upstream releases."""

import argparse
import ast
import gzip
import hashlib
import json
import re
import sys
import tempfile
import urllib.request
import zlib
from pathlib import Path


DESTINATION = Path(__file__).resolve().parents[1] / "public" / "tokenizers"


def read_source(name, item, source_dir):
    if source_dir:
        data = (source_dir / name).read_bytes()
    else:
        request = urllib.request.Request(item["url"], headers={"User-Agent": "Folio-Tokenizer-Builder/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise ValueError(f"Upstream checksum mismatch: {name}")
    return data


def qwen_config(raw):
    source = json.loads(raw)
    model = source["model"]
    added = {token["content"]: token["id"] for token in source["added_tokens"]}
    pattern = source["pre_tokenizer"]["pretokenizers"][0]["pattern"]["Regex"]
    # Rust's tokenizer regex supports group-local case folding and Unicode
    # White_Space. Express those operations in browser-compatible JS syntax.
    def fold_contractions(match):
        return "(?:" + re.sub("[a-z]", lambda m: "[" + m[0] + m[0].upper() + "]", match[1]) + ")"

    pattern = re.sub(r"\(\?i:([a-z'|]+)\)", fold_contractions, pattern)
    pattern = pattern.replace(r"\s", r"\p{White_Space}").replace(r"\S", r"\P{White_Space}")
    return {
        "vocab": {**model["vocab"], **added},
        "merges": [pair.split(" ") for pair in model["merges"]],
        "specialTokens": list(added),
        "config": {"splitRegex": pattern, "normalization": source["normalizer"]["type"]},
    }


def clip_config(merges, entities):
    # Read the literal entity table without executing downloaded Python.
    tree = ast.parse(entities.decode("utf-8"))
    entity_table = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign) and any(isinstance(n, ast.Name) and n.id == "html5" for n in node.targets)
    )
    # CLIP's 49,408 vocabulary slots include 512 byte variants and two special tokens.
    lines = gzip.decompress(merges).decode("utf-8").splitlines()
    return {"merges": [line.split(" ") for line in lines[1:48895]], "entities": entity_table}


def build(source_dir, check):
    manifest = json.loads((DESTINATION / "sources.json").read_text(encoding="utf-8"))
    sources = manifest["sources"]
    inputs = {name: read_source(name, item, source_dir) for name, item in sources.items()}
    vocabularies = {
        "qwen35.def": qwen_config(inputs["qwen.json"]),
        "t5.def": {"model": json.loads(inputs["t5.json"])["model"]},
        "clip.def": clip_config(inputs["clip.gz"], inputs["entities.py"]),
    }
    outputs = {name: data for name, data in inputs.items() if name.endswith("-LICENSE.txt")}
    for name, vocabulary in vocabularies.items():
        raw = json.dumps(vocabulary, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if hashlib.sha256(raw).hexdigest() != manifest["payloadSha256"][name]:
            raise ValueError(f"Rebuilt vocabulary checksum mismatch: {name}")
        compressor = zlib.compressobj(level=9, wbits=-15)
        outputs[name] = compressor.compress(raw) + compressor.flush()
    if check:
        for name, data in outputs.items():
            installed = (DESTINATION / name).read_bytes()
            if name.endswith(".def"):
                # Different zlib releases can use different DEFLATE blocks.
                installed, data = zlib.decompress(installed, -15), zlib.decompress(data, -15)
            if installed != data:
                raise ValueError(f"Installed data differs from verified upstream input: {name}")
            print(f"Verified {name}")
        return
    # Finish all downloads, validation, and packing before replacing a file.
    with tempfile.TemporaryDirectory(dir=DESTINATION) as temp:
        for name, data in outputs.items():
            (Path(temp) / name).write_bytes(data)
        for name in outputs:
            (Path(temp) / name).replace(DESTINATION / name)
            print(f"Built {name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="read files named in sources.json from this directory")
    parser.add_argument("--check", action="store_true", help="verify the shipped payloads without writing")
    args = parser.parse_args()
    try:
        build(args.source_dir, args.check)
    except (OSError, ValueError, KeyError, zlib.error) as error:
        sys.exit(str(error))
