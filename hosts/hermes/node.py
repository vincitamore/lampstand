"""Runs the lampstand CLI under Node at the adapter's bounded points (first turn, a tool call, the gate).

Node is found on PATH, then at $HERMES_HOME/node. The CLI is always given the resolved house through HOUSE_ROOT, so
Python and the CLI never disagree about which house a call is for.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

LAMPSTAND_JS = Path(__file__).resolve().parents[2] / "core" / "bin" / "lampstand.js"
CLI_TIMEOUT_SECONDS = 20.0


class NodeMissing(Exception):
    """Neither PATH nor $HERMES_HOME/node holds a node executable."""


class CliFailed(Exception):
    """The CLI could not be run, or did not answer with one JSON object."""


@dataclass(frozen=True)
class CliResult:
    exit: int
    data: dict


def find_node(env: Mapping[str, str] | None = None) -> str | None:
    env = os.environ if env is None else env
    found = shutil.which("node", path=env.get("PATH"))
    if found:
        return found
    home = env.get("HERMES_HOME")
    if not home:
        return None
    executable = "node.exe" if sys.platform == "win32" else "node"
    for directory in (Path(home) / "node", Path(home) / "node" / "bin"):
        candidate = directory / executable
        if candidate.is_file():
            return str(candidate)
    return None


def run_cli(
    args: list[str],
    root: str,
    env: Mapping[str, str] | None = None,
    *,
    stdin_text: str | None = None,
    operator: bool = False,
    timeout: float = CLI_TIMEOUT_SECONDS,
) -> CliResult:
    """Runs `lampstand <args> --json` for the house at `root`. Raises NodeMissing or CliFailed.

    `stdin_text` is handed to the CLI on stdin (for `--body -`). `operator` runs the verb as the person at the desktop
    rather than the agent: LAMPSTAND_AGENT, which this process carries for its agent's shells, is left out, so the
    operator's acts (adopt, strike) are not refused as an agent's."""
    env = dict(os.environ if env is None else env)
    if operator:
        env.pop("LAMPSTAND_AGENT", None)
    node = find_node(env)
    if node is None:
        raise NodeMissing()
    env["HOUSE_ROOT"] = root
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        completed = subprocess.run(
            [node, str(LAMPSTAND_JS), *args, "--json"],
            cwd=root,
            env=env,
            input=stdin_text,
            stdin=subprocess.DEVNULL if stdin_text is None else None,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=flags,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise CliFailed(f"lampstand {args[0]} did not finish within {timeout:.0f}s") from error
    except OSError as error:
        raise CliFailed(f"lampstand {args[0]} could not start: {error}") from error
    lines = completed.stdout.strip().splitlines()
    try:
        data = json.loads(lines[-1]) if lines else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        detail = (completed.stderr.strip() or completed.stdout.strip() or "no output").splitlines()[-1]
        raise CliFailed(f"lampstand {args[0]} exited {completed.returncode}: {detail}")
    return CliResult(exit=completed.returncode, data=data)
