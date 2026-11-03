"""Predicts whether the house's AGENTS.md region reaches the system prompt of a Hermes session at a working directory.

Hermes loads exactly one kind of project context file, the first kind found: `.hermes.md`/`HERMES.md` (nearest, walking
up to the git root), then the AGENTS.md chain (every directory from the git root down to the working directory; only
the working directory without a git root; per directory the first non-empty of AGENTS.override.md, AGENTS.md,
agents.md), then CLAUDE.md, then .cursorrules. A file over the context-file cap keeps only its head and tail. The
rules are mirrored here from Hermes's documented behaviour, read from files only; nothing of Hermes is imported.
"""

from __future__ import annotations

import os
from pathlib import Path

REGION_BEGIN = "<!-- house:begin -->"
REGION_END = "<!-- house:end -->"
KERNEL_MARKER = "<!-- lampstand:kernel -->"

# Hermes's floor for the per-file context cap and its head/tail split when a file runs over. The cap only grows with
# the model's window unless the operator pins a smaller one, so the floor is the conservative reading.
CONTEXT_FILE_MAX_CHARS = 20_000
TRUNCATE_HEAD_RATIO = 0.7
TRUNCATE_TAIL_RATIO = 0.2

HERMES_MD_NAMES = (".hermes.md", "HERMES.md")
AGENTS_MD_NAMES = ("AGENTS.override.md", "AGENTS.md", "agents.md")


def _exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def _read_stripped(path: Path) -> str:
    """The file's text stripped of surrounding whitespace, "" when missing or unreadable (as Hermes reads it)."""
    try:
        return path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def find_git_root(start: Path) -> Path | None:
    """The nearest of `start` and its ancestors holding a `.git` entry (directory or file)."""
    return next((p for p in (start, *start.parents) if _exists(p / ".git")), None)


def _hermes_md(cwd: Path, git_root: Path | None) -> Path | None:
    # Without a git root only the working directory is searched: walking parents could pick up a stray file.
    for directory in (cwd, *cwd.parents) if git_root else (cwd,):
        found = next((directory / n for n in HERMES_MD_NAMES if _is_file(directory / n)), None)
        if found or directory == git_root:
            return found
    return None


def _agents_chain(cwd: Path, git_root: Path | None) -> list[Path]:
    if git_root is None or git_root == cwd or not cwd.is_relative_to(git_root):
        return [cwd]
    parts = cwd.relative_to(git_root).parts
    return [git_root] + [git_root.joinpath(*parts[: i + 1]) for i in range(len(parts))]


def region_span(text: str) -> tuple[int, int] | None:
    """Offsets of the region in `text`, from the start of the begin marker line to the end of the end marker line, or
    None unless each marker is present once as a whole line, begin before end, with the kernel marker between them."""
    lines = text.split("\n")
    begin = [k for k, line in enumerate(lines) if line.rstrip("\r") == REGION_BEGIN]
    end = [k for k, line in enumerate(lines) if line.rstrip("\r") == REGION_END]
    if len(begin) != 1 or len(end) != 1 or end[0] <= begin[0]:
        return None
    if not any(line.rstrip("\r") == KERNEL_MARKER for line in lines[begin[0] + 1 : end[0]]):
        return None
    offset = sum(len(line) + 1 for line in lines[: begin[0]])
    stop = sum(len(line) + 1 for line in lines[: end[0]]) + len(lines[end[0]])
    return offset, stop


def _survives_truncation(rendered: str, span: tuple[int, int]) -> bool:
    if len(rendered) <= CONTEXT_FILE_MAX_CHARS:
        return True
    head = int(CONTEXT_FILE_MAX_CHARS * TRUNCATE_HEAD_RATIO)
    tail = int(CONTEXT_FILE_MAX_CHARS * TRUNCATE_TAIL_RATIO)
    return span[1] <= head or span[0] >= len(rendered) - tail


def house_region_loads(root: str, cwd: str) -> bool:
    """True when a Hermes session working in `cwd` loads the generated region (with its kernel) of the AGENTS.md
    context file in the house at `root`."""
    here = Path(cwd).resolve()
    house = Path(root).resolve()
    git_root = find_git_root(here)

    hermes_md = _hermes_md(here, git_root)
    if hermes_md is not None and _read_stripped(hermes_md):
        return False
    if house not in _agents_chain(here, git_root):
        return False

    for name in AGENTS_MD_NAMES:
        candidate = house / name
        if not _exists(candidate):
            continue
        content = _read_stripped(candidate).removeprefix("\ufeff")
        if not content:
            continue
        span = region_span(content)
        if span is None:
            return False
        label = name if house == here else os.path.relpath(candidate, here)
        prefix = f"## {label}\n\n"
        rendered = prefix + content
        return _survives_truncation(rendered, (span[0] + len(prefix), span[1] + len(prefix)))
    return False
