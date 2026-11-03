"""The projection reader agrees with the JS compiler on freshness, flags staleness, and refuses a non-projection."""

from __future__ import annotations

from hosts.hermes.projection import ProjectionError, read_projection

from .support import TempTestCase


class ProjectionReader(TempTestCase):
    def test_a_fresh_compile_by_the_js_core_verifies(self) -> None:
        root = self.make_house(generated="node")
        for name in ("kernel.md", "router.hermes.md", "worker.hermes.md", "watchdog.md"):
            with self.subTest(name):
                projection = read_projection(str(root), name)
                self.assertFalse(projection.stale)
                self.assertIsNone(projection.notice)
        kernel = read_projection(str(root), "kernel.md")
        self.assertEqual(kernel.marker, "<!-- lampstand:kernel -->")
        self.assertIn("Purpose: Keep the test honest.", kernel.body)

    def test_a_changed_input_makes_it_stale_but_still_loadable(self) -> None:
        root = self.make_house()
        (root / "voice.md").write_text("# Voice\n\nPlain words.\n", encoding="utf-8")
        projection = read_projection(str(root), "kernel.md")
        self.assertTrue(projection.stale)
        self.assertIn("lampstand compile", projection.notice)
        self.assertIn("Purpose: Keep the test honest.", projection.body)

    def test_line_endings_and_a_bom_do_not_make_it_stale(self) -> None:
        root = self.make_house()
        for path in (root / "house.toml", root / "principles" / "own.md", root / ".house" / "generated" / "kernel.md"):
            path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes().replace(b"\n", b"\r\n"))
        self.assertFalse(read_projection(str(root), "kernel.md").stale)

    def test_missing_or_headerless_projections_are_refused(self) -> None:
        root = self.make_house(generated=None)
        with self.assertRaisesRegex(ProjectionError, "has not been generated"):
            read_projection(str(root), "kernel.md")
        generated = root / ".house" / "generated"
        generated.mkdir(parents=True)
        (generated / "kernel.md").write_text("<!-- lampstand:kernel -->\nPurpose: forged\n", encoding="utf-8")
        with self.assertRaisesRegex(ProjectionError, "header and marker"):
            read_projection(str(root), "kernel.md")
