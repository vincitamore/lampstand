"""The projection input hash is computable from the header alone with the standard library.

A Hermes loader verifies a projection by recomputing this hash; these vectors pin the definition it must follow.
"""

import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VECTORS = json.loads((REPO / "schema" / "constitution" / "input-hash.json").read_text(encoding="utf-8"))["vectors"]
HEADER_INPUTS = "house.toml, principles/*.md, charter/core.md, charter/provisions/*.md, reflexes/*.md, voice.md"


def content_hash(raw: bytes) -> str:
    text = raw.decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def hashed_text(path: str, text: str) -> str:
    """house.toml as the compiler reads it: no blank or comment lines, and no [jobs], [modules] or [gate] table."""
    if path != "house.toml":
        return text
    skipping = False
    kept = []
    for line in text.split("\n"):
        trimmed = line.strip()
        if trimmed == "" or trimmed.startswith("#"):
            continue
        if trimmed.startswith("["):
            first = re.split(r"[.\] \t]", re.sub(r"^\[+[ \t]*", "", trimmed), maxsplit=1)[0]
            first = re.sub(r"^([\"'])(.*)\1$", r"\2", first)
            skipping = first in ("jobs", "modules", "gate")
        if not skipping:
            kept.append(line)
    return "\n".join(kept) + "\n" if kept else ""


def input_paths(root: Path, specs: str) -> list[str]:
    paths = []
    for spec in specs.split(", "):
        if spec.endswith("/*.md"):
            folder = spec[: -len("/*.md")]
            directory = root / folder
            if directory.is_dir():
                names = sorted(p.name for p in directory.iterdir() if p.is_file() and p.name.endswith(".md"))
                paths.extend(f"{folder}/{name}" for name in names)
        elif (root / spec).is_file():
            paths.append(spec)
    return paths


def input_hash(root: Path, paths: list[str]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        text = (root / path).read_bytes().decode("utf-8").removeprefix("\ufeff").replace("\r\n", "\n")
        digest.update(f"{path}\n{content_hash(hashed_text(path, text).encode('utf-8'))}\n".encode())
    return digest.hexdigest()


class InputHashVectors(unittest.TestCase):
    def test_vectors(self) -> None:
        for vector in VECTORS:
            with self.subTest(vector["name"]), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                for rel, text in vector["files"].items():
                    target = root.joinpath(*rel.split("/"))
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(text.encode("utf-8"))
                paths = input_paths(root, HEADER_INPUTS)
                self.assertEqual(paths, vector["input-paths"])
                self.assertEqual(input_hash(root, paths), vector["input-hash"])


if __name__ == "__main__":
    unittest.main()
