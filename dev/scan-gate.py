#!/usr/bin/env python3
"""Runs Hermes's own plugin validation on the release tree and judges its security-scan verdict.

The tree is built by dev/release.js from the repository's dev/release-allowlist.json, the same tree the default branch
carries and a user's `hermes plugins install` clones, so dev/, test/ and other files that never ship cannot change the
verdict. Hermes runs from a given install's Python (the dependency venv that imports
`hermes_cli`), under a throwaway HERMES_HOME, with lazy installs off, so the run reads and writes nothing of the real
Hermes home. `dangerous` fails. `caution` passes only when every finding is listed in dev/scan-dispositions.json by
pattern id, file and line, with a one-line disposition; the shipped files are never edited to change a verdict.
Validation failing on anything else (manifest, capability probe) fails too.

Exit codes: 0 pass, 1 finding, 2 could not run, 64 usage.

    python dev/scan-gate.py [<hermes python>] [--root <repo>] [--dispositions <file>]
    (or HERMES_PYTHON=<hermes python> python dev/scan-gate.py)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_NAME = "lampstand"

# Runs inside the Hermes Python: the same scan_plugin call `plugins validate` makes, with every finding kept (the
# validator's summary keeps only critical and high ones, by file basename).
SCAN_SCRIPT = r"""
import json, sys
from pathlib import Path
from tools.plugin_guard import scan_plugin
try:
    from tools.plugin_guard import PLUGIN_SCANNER_VERSION as scanner
except ImportError:
    scanner = None
try:
    from hermes_cli import __version__ as version
except ImportError:
    version = None
root = Path(sys.argv[1])
result = scan_plugin(root)
def rel(name):
    p = Path(name)
    try:
        return p.resolve().relative_to(root.resolve()).as_posix() if p.is_absolute() else p.as_posix()
    except ValueError:
        return p.as_posix()
print(json.dumps({
    "hermes": version, "scanner": scanner, "verdict": result.verdict,
    "findings": [{"id": f.pattern_id, "severity": f.severity, "category": f.category, "file": rel(f.file),
                  "line": f.line, "description": f.description} for f in result.findings],
}))
"""


class CouldNotRun(Exception):
    pass


def load_dispositions(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CouldNotRun(f"{path}: {error}") from error
    items = data.get("dispositions") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise CouldNotRun(f'{path}: expected {{"dispositions": [...]}}')
    for item in items:
        ok = (
            isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and isinstance(item.get("file"), str)
            and isinstance(item.get("line"), int)
            and isinstance(item.get("disposition"), str)
            and item["disposition"].strip() != ""
            and "\n" not in item["disposition"]
        )
        if not ok:
            raise CouldNotRun(f"{path}: each disposition needs id, file, line (an integer) and a one-line disposition")
    return items


def judge(verdict: str, findings: list[dict], dispositions: list[dict]) -> tuple[bool, list[str]]:
    """The gate's decision on a scan result, and the lines that explain it.

    A `safe` verdict passes with a count of its findings by severity and pattern (the scanner judged none of them
    worth a prompt); `caution` lists every finding against the dispositions; `dangerous` lists them and fails.
    """
    if verdict == "safe":
        counts: dict[tuple[str, str], int] = {}
        for f in findings:
            counts[(f["severity"], f["id"])] = counts.get((f["severity"], f["id"]), 0) + 1
        summary = [f"  {n:4d} {severity} {pattern}" for (severity, pattern), n in sorted(counts.items())]
        return True, [*summary, "scan-gate: verdict safe; passes"]
    if verdict not in ("caution", "dangerous"):
        return False, [f"scan-gate: unknown verdict {verdict!r}"]
    lines: list[str] = []
    keyed = {(d["id"], d["file"], d["line"]): d for d in dispositions}
    used = set()
    undisposed = 0
    for f in sorted(findings, key=lambda f: (f["file"], f["line"], f["id"])):
        key = (f["id"], f["file"], f["line"])
        disposition = keyed.get(key)
        where = f"{f['file']}:{f['line']}: {f['id']} ({f['severity']}, {f['category']})"
        if disposition is not None:
            used.add(key)
            lines.append(f"  disposed   {where}: {disposition['disposition']}")
        else:
            undisposed += 1
            lines.append(f"  UNDISPOSED {where}: {f['description']}")
    for key in sorted(set(keyed) - used):
        lines.append(f"  note: unused disposition {key[1]}:{key[2]} {key[0]}")
    if verdict == "dangerous":
        return False, [*lines, "scan-gate: verdict dangerous; no disposition can pass it"]
    if undisposed > 0:
        return False, [*lines, f"scan-gate: verdict caution with {undisposed} undisposed findings"]
    return True, [*lines, "scan-gate: verdict caution; every finding disposed; passes"]


def export(root: Path, dest: Path) -> None:
    """Builds the release tree of `root` into `dest` with this tree's dev/release.js and `root`'s allowlist."""
    node = shutil.which("node")
    if node is None:
        raise CouldNotRun("node is not on PATH, and dev/release.js builds the tree to scan")
    script = Path(__file__).resolve().parent / "release.js"
    manifest = dest.parent / "release.manifest.json"
    result = subprocess.run(
        [node, str(script), "--root", str(root), "--out", str(dest), "--manifest", str(manifest)],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        raise CouldNotRun(f"dev/release.js could not build the tree: {(result.stdout + result.stderr).strip()}")


def hermes(python: str, args: list[str], work: Path) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME", "HERMES_HOME")}
    env["HERMES_HOME"] = str(work / "hermes-home")
    env["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        return subprocess.run(
            [python, "-P", *args],
            cwd=work,
            env=env,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=50,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CouldNotRun(f"{python}: {error}") from error


def last_json(text: str) -> dict | None:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="scan-gate", description=__doc__.splitlines()[0])
    parser.add_argument("python", nargs="?", default=os.environ.get("HERMES_PYTHON"))
    parser.add_argument("--root", default=str(HERE.parent))
    parser.add_argument("--dispositions", default=str(HERE / "scan-dispositions.json"))
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return 0 if exit_.code == 0 else 64
    if not args.python:
        print("scan-gate: give a Hermes install's Python as an argument or in HERMES_PYTHON", file=sys.stderr)
        return 64
    try:
        dispositions = load_dispositions(Path(args.dispositions))
        work = Path(tempfile.mkdtemp(prefix="lampstand-scan-gate-"))
        try:
            (work / "hermes-home").mkdir()
            plugin = work / PLUGIN_NAME
            export(Path(args.root), plugin)
            validate = hermes(
                args.python, ["-m", "hermes_cli.main", "plugins", "validate", str(plugin), "--json"], work
            )
            report = last_json(validate.stdout)
            if report is None:
                detail = (validate.stderr.strip() or validate.stdout.strip() or "no output").splitlines()[-1]
                raise CouldNotRun(f"hermes plugins validate exited {validate.returncode}: {detail}")
            scan = hermes(args.python, ["-c", SCAN_SCRIPT, str(plugin)], work)
            result = last_json(scan.stdout)
            if result is None:
                detail = (scan.stderr.strip() or scan.stdout.strip() or "no output").splitlines()[-1]
                raise CouldNotRun(f"the scanner exited {scan.returncode}: {detail}")
        finally:
            shutil.rmtree(work, ignore_errors=True)
    except CouldNotRun as error:
        print(f"scan-gate: could not run: {error}", file=sys.stderr)
        return 2

    version = result.get("hermes") or "(version unknown)"
    print(f"scan-gate: Hermes {version}, scanner {result.get('scanner') or '(unknown)'}")
    failed_checks = [c for c in report.get("checks", []) if not c.get("ok")]
    for check in report.get("checks", []):
        print(f"  {'ok  ' if check.get('ok') else 'FAIL'} {check.get('name')}: {check.get('detail')}")
    for warning in report.get("warnings", []):
        print(f"  warning: {warning}")
    print(f"scan-gate: verdict {result['verdict']}, {len(result['findings'])} findings")
    ok, lines = judge(result["verdict"], result["findings"], dispositions)
    for line in lines:
        print(line)
    if failed_checks:
        names = ", ".join(str(c.get("name")) for c in failed_checks)
        print(f"scan-gate: hermes plugins validate failed: {names}")
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
