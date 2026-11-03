"""The Python frontmatter reader splits every valid frontmatter vector where the JS reader does.

Python never parses the YAML (DESIGN §3); it removes the block and keeps the body. So it runs the vectors of
schema/conformance/frontmatter/valid.json for their body, which is what it reads, block scalars and multi-line flow
collections included.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from hosts.hermes.plugin import strip_frontmatter

REPO = Path(__file__).resolve().parents[2]


class FrontmatterFences(unittest.TestCase):
    def test_valid_vectors_split_to_the_same_body(self) -> None:
        vectors = json.loads((REPO / "schema" / "conformance" / "frontmatter" / "valid.json").read_text(encoding="utf-8"))["vectors"]
        self.assertGreater(len(vectors), 25)
        for vector in vectors:
            with self.subTest(vector["description"]):
                # read_text's normalization: one leading BOM removed, CRLF turned into LF.
                text = vector["input"].removeprefix("\ufeff").replace("\r\n", "\n")
                self.assertEqual(strip_frontmatter(text), vector["expected"]["body"])


if __name__ == "__main__":
    unittest.main()
