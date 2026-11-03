"""The Python twin passes the same vectors as the JS core: house resolution and both hash definitions."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from hosts.hermes.projection import content_hash, input_hash, input_paths
from hosts.hermes.root import LampstandError, resolve_house

from .support import REPO, plant, vectors

INPUT_SPECS = [
    "house.toml",
    "principles/*.md",
    "charter/core.md",
    "charter/provisions/*.md",
    "reflexes/*.md",
    "voice.md",
]


class RootResolutionVectors(unittest.TestCase):
    def test_every_vector(self) -> None:
        cases = vectors("root")
        self.assertGreater(len(cases), 20)
        for vector in cases:
            with self.subTest(vector["description"]), tempfile.TemporaryDirectory() as raw:
                t = Path(os.path.realpath(raw))
                for rel in vector.get("dirs", []):
                    t.joinpath(*rel.split("/")).mkdir(parents=True, exist_ok=True)
                plant(t, vector.get("files", {}))
                if "config" in vector:
                    plant(t, {"config/lampstand/config.toml": vector["config"].replace("{T}", str(t))})
                env = {k: v.replace("{T}", str(t)) for k, v in vector["env"].items()}
                env["LAMPSTAND_CONFIG_ROOT"] = str(t / "config")
                cwd = str(t.joinpath(*vector["cwd"].split("/"))) if vector["cwd"] else str(t)
                expect = vector["expect"]
                if "error" in expect:
                    with self.assertRaises(LampstandError) as caught:
                        resolve_house(cwd, env, vector["workspace"])
                    self.assertEqual(caught.exception.code, expect["error"])
                    continue
                found = resolve_house(cwd, env, vector["workspace"])
                self.assertEqual(found.rule, expect["rule"])
                if expect["root"] is None:
                    self.assertIsNone(found.root)
                else:
                    self.assertEqual(Path(found.root), t.joinpath(*expect["root"].split("/")) if expect["root"] else t)


class HashVectors(unittest.TestCase):
    def test_content_hash(self) -> None:
        for vector in vectors("hash"):
            with self.subTest(vector["description"]):
                self.assertEqual(content_hash(vector["input"].encode("utf-8")), vector["sha256"])

    def test_input_hash(self) -> None:
        spec = json.loads((REPO / "schema" / "constitution" / "input-hash.json").read_text(encoding="utf-8"))
        for vector in spec["vectors"]:
            with self.subTest(vector["name"]), tempfile.TemporaryDirectory() as raw:
                root = Path(raw)
                plant(root, vector["files"])
                paths = input_paths(str(root), INPUT_SPECS)
                self.assertEqual(paths, vector["input-paths"])
                self.assertEqual(input_hash(str(root), paths), vector["input-hash"])


if __name__ == "__main__":
    unittest.main()
