"""dev/scan-gate.py: the verdict policy, and (given a Hermes install's Python in HERMES_PYTHON) a real scan.

The real-scan cases plant a minimal plugin in a temp git repository and commit it, since the gate scans
`git archive HEAD`; the scanner runs under the gate's own throwaway HERMES_HOME.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("scan_gate", REPO / "dev" / "scan-gate.py")
assert _spec is not None and _spec.loader is not None
scan_gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan_gate)

HERMES_PYTHON = os.environ.get("HERMES_PYTHON")


def remove_tree(path: Path) -> None:
    """Removes a temp tree; git writes its objects read-only, which Windows refuses to delete until made writable."""

    def retry(func, target, _error) -> None:
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=retry)
    else:
        shutil.rmtree(path, onerror=retry)


def temp_dir(test: unittest.TestCase) -> Path:
    path = Path(tempfile.mkdtemp(prefix="lampstand-gates-"))
    test.addCleanup(remove_tree, path)
    return path


def finding(pattern: str = "python_os_system", file: str = "tool.py", line: int = 4, severity: str = "high") -> dict:
    return {
        "id": pattern,
        "severity": severity,
        "category": "execution",
        "file": file,
        "line": line,
        "description": "d",
    }


def disposition(pattern: str = "python_os_system", file: str = "tool.py", line: int = 4) -> dict:
    return {"id": pattern, "file": file, "line": line, "disposition": "runs a fixed command the plugin documents"}


class JudgeTest(unittest.TestCase):
    def test_safe_passes_whatever_it_found(self) -> None:
        ok, lines = scan_gate.judge("safe", [finding(severity="medium")], [])
        self.assertTrue(ok)
        self.assertEqual(lines[-1], "scan-gate: verdict safe; passes")

    def test_dangerous_fails_even_when_every_finding_is_disposed(self) -> None:
        ok, lines = scan_gate.judge("dangerous", [finding(severity="critical")], [disposition()])
        self.assertFalse(ok)
        self.assertIn("dangerous", lines[-1])

    def test_caution_fails_on_a_finding_without_a_disposition(self) -> None:
        findings = [finding(), finding(file="other.py", line=9)]
        ok, lines = scan_gate.judge("caution", findings, [disposition()])
        self.assertFalse(ok)
        self.assertIn("  UNDISPOSED other.py:9: python_os_system (high, execution): d", lines)
        self.assertEqual(lines[-1], "scan-gate: verdict caution with 1 undisposed findings")

    def test_caution_passes_when_every_finding_matches_id_file_and_line(self) -> None:
        ok, _ = scan_gate.judge("caution", [finding()], [disposition()])
        self.assertTrue(ok)
        ok, _ = scan_gate.judge("caution", [finding()], [disposition(line=5)])
        self.assertFalse(ok, "a disposition for another line must not cover the finding")

    def test_an_unknown_verdict_fails(self) -> None:
        ok, _ = scan_gate.judge("unreviewed", [], [])
        self.assertFalse(ok)


class CommandLineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = temp_dir(self)

    def run_main(self, args: list[str]) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = scan_gate.main(args)
        return code, out.getvalue()

    def test_no_hermes_python_is_a_usage_error(self) -> None:
        saved = os.environ.pop("HERMES_PYTHON", None)
        self.addCleanup(lambda: saved is None or os.environ.__setitem__("HERMES_PYTHON", saved))
        code, out = self.run_main(["--root", str(self.dir)])
        self.assertEqual(code, 64, out)

    def test_a_multi_line_disposition_cannot_run(self) -> None:
        bad = self.dir / "dispositions.json"
        item = {"id": "x", "file": "a.py", "line": 1, "disposition": "one\ntwo"}
        bad.write_text(json.dumps({"dispositions": [item]}), encoding="utf-8")
        code, out = self.run_main(["python", "--root", str(self.dir), "--dispositions", str(bad)])
        self.assertEqual(code, 2, out)
        self.assertIn("one-line disposition", out)


@unittest.skipUnless(HERMES_PYTHON, "set HERMES_PYTHON to a Hermes install's Python to run the real scan")
class RealScanTest(unittest.TestCase):
    MANIFEST = "manifest_version: 2\nname: probe\nversion: 0.0.1\ndescription: a probe plugin\nkind: standalone\n"

    def setUp(self) -> None:
        self.dir = temp_dir(self)
        self.repo = self.dir / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        (self.repo / "dev").mkdir()
        allowlist = {"include": ["plugin.yaml", "__init__.py", "*.py"], "exclude": []}
        (self.repo / "dev" / "release-allowlist.json").write_text(json.dumps(allowlist), encoding="utf-8")
        self.commit({"plugin.yaml": self.MANIFEST, "__init__.py": "def register(ctx):\n    return None\n"})

    def git(self, *args: str) -> None:
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
            cwd=self.repo,
            check=True,
            capture_output=True,
        )

    def commit(self, files: dict[str, str]) -> None:
        for name, text in files.items():
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(text, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "plant")

    def run_gate(self, dispositions: list[dict] | None = None) -> tuple[int, str]:
        path = self.dir / "dispositions.json"
        path.write_text(json.dumps({"dispositions": dispositions or []}), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(REPO / "dev" / "scan-gate.py"), str(HERMES_PYTHON), "--root", str(self.repo)]
            + ["--dispositions", str(path)],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=55,
            check=False,
        )
        return result.returncode, result.stdout + result.stderr

    def test_a_clean_plugin_passes_and_a_file_that_never_ships_is_not_scanned(self) -> None:
        self.commit({"test/wipe.py": 'import os\nos.system("rm -rf / --no-preserve-root")\n'})
        code, out = self.run_gate()
        self.assertEqual(code, 0, out)
        self.assertIn("scan-gate: verdict safe; passes", out)

    def test_a_committed_destructive_command_is_dangerous(self) -> None:
        self.commit({"wipe.py": 'import os\n\n\ndef wipe():\n    os.system("rm -rf / --no-preserve-root")\n'})
        code, out = self.run_gate([disposition("destructive_root_rm", "wipe.py", 5)])
        self.assertEqual(code, 1, out)
        self.assertIn("verdict dangerous; no disposition can pass it", out)

    def test_caution_fails_until_its_finding_is_disposed(self) -> None:
        self.commit({"tool.py": 'import os\n\n\ndef listing():\n    os.system("ls")\n'})
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn("UNDISPOSED tool.py:5: python_os_system", out)
        code, out = self.run_gate([disposition("python_os_system", "tool.py", 5)])
        self.assertEqual(code, 0, out)
        self.assertIn("every finding disposed", out)


if __name__ == "__main__":
    unittest.main()
