"""The `lampstand-kernel` section: K when the house's AGENTS.md region will not load in the session, else a pointer.

"Will load" follows Hermes's context-file choice: one kind of file wins (.hermes.md first, then the AGENTS.md chain
from the git root down to the working directory), AGENTS.override.md shadows AGENTS.md in its directory, and a file
over the context cap keeps only its head and tail.
"""

from __future__ import annotations

from pathlib import Path

from hosts.hermes import plugin

from .support import RecordingContext, TempTestCase, region

KERNEL_MARKER = "<!-- lampstand:kernel -->"


class KernelSection(TempTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.root = self.make_house()
        (self.root / ".git").mkdir()
        self.region = region(self.root / ".house" / "generated" / "kernel.md")
        (self.root / "AGENTS.md").write_text(f"# Our manual\n\n{self.region}", encoding="utf-8")
        ctx = RecordingContext()
        plugin.register(ctx)
        self.render, self.max_chars = ctx.sections["lampstand-kernel"]

    def section(self, cwd: Path, platform: str = "cli") -> str:
        return self.render({"cwd": str(cwd), "platform": platform, "session_id": "s"})

    def assert_pointer(self, text: str) -> None:
        self.assertEqual(len(text.splitlines()), 1, text)
        self.assertNotIn(KERNEL_MARKER, text)
        self.assertIn("loads from its AGENTS.md region", text)

    def assert_kernel(self, text: str) -> None:
        self.assertTrue(text.startswith(KERNEL_MARKER + "\n"), text)
        self.assertIn("Purpose: Keep the test honest.", text)
        self.assertIn("router.hermes.md", text.splitlines()[-1])
        self.assertLessEqual(len(text), self.max_chars)

    def test_the_section_is_registered_within_the_hermes_cap(self) -> None:
        self.assertEqual(self.max_chars, 4000)

    def test_region_loads_at_the_house_root_and_below_it(self) -> None:
        (self.root / "tasks" / "deep").mkdir(parents=True)
        self.assert_pointer(self.section(self.root))
        self.assert_pointer(self.section(self.root / "tasks" / "deep"))

    def test_a_nested_repository_shadows_the_house(self) -> None:
        app = self.root / "forge" / "app"
        (app / ".git").mkdir(parents=True)
        (app / "src").mkdir()
        self.assert_kernel(self.section(app / "src"))

    def test_without_a_git_root_only_the_working_directory_counts(self) -> None:
        (self.root / ".git").rmdir()
        (self.root / "tasks" / "deep").mkdir(parents=True)
        self.assert_pointer(self.section(self.root))
        self.assert_kernel(self.section(self.root / "tasks" / "deep"))

    def test_a_hermes_md_wins_over_agents_md_unless_it_is_empty(self) -> None:
        (self.root / ".hermes.md").write_text("  \n", encoding="utf-8")
        self.assert_pointer(self.section(self.root))
        (self.root / ".hermes.md").write_text("Project notes.\n", encoding="utf-8")
        self.assert_kernel(self.section(self.root))

    def test_an_agents_override_shadows_the_house_agents_md(self) -> None:
        (self.root / "AGENTS.override.md").write_text("My local rules.\n", encoding="utf-8")
        self.assert_kernel(self.section(self.root))

    def test_an_agents_md_without_a_filled_region_does_not_count(self) -> None:
        (self.root / "AGENTS.md").write_text("# Manual\n\n<!-- house:begin -->\n<!-- house:end -->\n", encoding="utf-8")
        self.assert_kernel(self.section(self.root))

    def test_a_region_cut_by_truncation_does_not_count(self) -> None:
        manual = "# Manual\n\n" + ("A line of the operator's own text.\n" * 600)
        (self.root / "AGENTS.md").write_text(manual + self.region + manual, encoding="utf-8")
        self.assert_kernel(self.section(self.root))
        (self.root / "AGENTS.md").write_text(self.region + manual, encoding="utf-8")
        self.assert_pointer(self.section(self.root))
        (self.root / "AGENTS.md").write_text(manual + self.region, encoding="utf-8")
        self.assert_pointer(self.section(self.root))

    def test_dormant_and_subagent_sessions_get_nothing(self) -> None:
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        self.assertEqual(self.section(elsewhere), "")
        self.assertEqual(self.section(self.root / "forge", platform="subagent"), "")

    def test_a_kernel_near_the_cap_drops_the_extras_and_never_exceeds_it(self) -> None:
        app = self.root / "forge" / "app"
        (app / ".git").mkdir(parents=True)
        kernel_file = self.root / ".house" / "generated" / "kernel.md"
        header = kernel_file.read_text(encoding="utf-8").splitlines()[0]
        for size, expect_marker in ((3300, True), (3990, False)):
            with self.subTest(size):
                body = "Purpose: " + "x" * (size - len("Purpose: "))
                kernel_file.write_text(f"{header}\n{KERNEL_MARKER}\n{body}\n", encoding="utf-8")
                text = self.section(app)
                self.assertLessEqual(len(text), 4000)
                self.assertIn(body, text)
                self.assertEqual(text.startswith(KERNEL_MARKER), expect_marker)
        kernel_file.write_text(f"{header}\n{KERNEL_MARKER}\n{'y' * 4001}\n", encoding="utf-8")
        self.assertEqual(self.section(app), "")
