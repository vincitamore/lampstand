"""What the house cockpit reads and does: the desktop's House page and the agent's house tools share this module.

Reads come from the house's own files and from the lampstand CLI's JSON (the CLI is the one authority on the org, the
constitution and the gate; nothing here re-implements a rule it enforces). Acts are a closed list, each one CLI verb
(or, for record.commit, one git commit of the house's org files): there is no path from the cockpit to an arbitrary
command. Every act that writes lands as one commit of exactly the paths it changed. An act the desktop makes is the
person's (`operator=True` drops the agent marker), an act the agent makes through a tool is the agent's and the CLI
refuses it the operator's verbs as it does in any agent shell.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import tomllib
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .node import CliFailed, NodeMissing, run_cli
from .root import LampstandError, has_house_toml, read_text, resolve_house

REGISTER_FILE = "houses.json"
DOC_MAX_BYTES = 512 * 1024
DOC_SUFFIXES = (".md", ".toml", ".json", ".txt", ".jsonl", ".yaml", ".yml")
BACKLINK_SCAN_MAX = 4000
KERNEL_CAP = 4000
# Folders a house keeps its constitution in, in the order the page shows them.
CONSTITUTION_FOLDERS = ("principles", "charter", "reflexes")
CONSTITUTION_FILES = ("voice.md", "curation.md")
WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")


class CockpitError(Exception):
    """A request the cockpit refuses, with a message fit to show."""


# ---- the register of houses --------------------------------------------------------------------------------------


def _state_dir() -> Path:
    from .store import state_dir

    return state_dir()


def _read_register() -> dict:
    from .store import read_json

    try:
        data = read_json(_state_dir() / REGISTER_FILE, {})
    except OSError:
        return {}
    return data if isinstance(data, dict) else {}


def _change_register(change: Callable[[dict], Any]) -> Any:
    """Applies `change` to the register's houses under the file lock (several processes write it) and saves it."""
    from .store import locked, read_json, write_json

    path = _state_dir() / REGISTER_FILE
    with locked(path):
        data = read_json(path, {})
        if not isinstance(data, dict):
            data = {}
        houses = data.get("houses")
        if not isinstance(houses, dict):
            houses = data["houses"] = {}
        result = change(houses)
        write_json(path, data)
        return result


def remember_house(root: str) -> None:
    """Records that a session worked in the house at `root`, so the desktop lists it."""
    root = os.path.realpath(root)
    seen = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def note(houses: dict) -> None:
        entry = houses.get(root) if isinstance(houses.get(root), dict) else {}
        entry["seen"] = seen
        houses[root] = entry

    _change_register(note)


def forget_house(root: str) -> bool:
    root = os.path.realpath(root)

    def drop(houses: dict) -> bool:
        return houses.pop(root, None) is not None

    return bool(_change_register(drop))


def identity(root: str) -> dict:
    """A house's identity from its house.toml: name, operator, purpose, charter mode, modules. Never raises."""
    out: dict[str, Any] = {"root": root, "name": os.path.basename(root), "ok": True}
    try:
        data = tomllib.loads(read_text(os.path.join(root, "house.toml")))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        out.update(ok=False, error=f"house.toml: {error}")
        return out
    house, operator, purpose, charter, modules, gate, budget = (
        _table(data, key) for key in ("house", "operator", "purpose", "charter", "modules", "gate", "budget")
    )
    out.update(
        id=house.get("id"),
        name=str(house.get("name") or out["name"]),
        operator=str(operator.get("name") or ""),
        co_owners=[str(c) for c in operator.get("co_owners") or [] if isinstance(c, str)],
        purpose=str(purpose.get("text") or ""),
        charter=str(charter.get("mode") or "none"),
        ask_first=[str(a) for a in charter.get("ask_first") or [] if isinstance(a, str)],
        modules={str(k): bool(v) for k, v in modules.items()},
        gate=str(gate.get("mode") or ""),
        budget=str(budget.get("profile") or ""),
    )
    return out


def _table(data: Mapping[str, Any], key: str) -> dict:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _scan(directory: str) -> list[str]:
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    return [os.path.realpath(os.path.join(directory, n)) for n in names if has_house_toml(os.path.join(directory, n))]


def known_houses(scan_dirs: list[str] | None = None, extra: list[str] | None = None) -> list[dict]:
    """Every house this seat knows: the ones sessions worked in, every house directly under the configured folders,
    and `extra` (the focused session's own house). Each with its identity and whether it still exists."""
    seen: dict[str, dict] = {}
    register = (_read_register().get("houses") or {}) if isinstance(_read_register().get("houses"), dict) else {}
    roots: list[tuple[str, str]] = [(r, "remembered") for r in register]
    for directory in scan_dirs or []:
        roots += [(r, "folder") for r in _scan(os.path.expanduser(directory))]
    roots += [(os.path.realpath(r), "session") for r in extra or [] if r]
    for root, source in roots:
        if root in seen:
            continue
        if not has_house_toml(root):
            seen[root] = {"root": root, "name": os.path.basename(root), "ok": False, "missing": True, "source": source}
            continue
        info = identity(root)
        info["source"] = source
        info["seen"] = (register.get(root) or {}).get("seen")
        seen[root] = info
    return sorted(seen.values(), key=lambda h: (h.get("missing", False), str(h.get("name", "")).lower()))


def checked_root(root: str) -> str:
    """`root` as a house the cockpit may read: an absolute directory holding house.toml."""
    if not root or not os.path.isabs(root):
        raise CockpitError("name the house by its absolute path")
    real = os.path.realpath(root)
    if not has_house_toml(real):
        raise CockpitError(f"{root} holds no house.toml")
    return real


_known: tuple[float, frozenset[str]] = (0.0, frozenset())
KNOWN_TTL = 10.0


def known_root(root: str, scan_dirs: list[str] | None = None) -> str:
    """`root` as a house the desktop may read or act in: a house this seat already knows (one a session worked in, or
    one under the scanned folders). A path named by anything else (a model's transcript card, a crafted request) is
    refused rather than read, so nothing outside the seat's own houses is opened or registered by asking."""
    global _known
    real = checked_root(root)
    stamp, roots = _known
    if os.path.normcase(real) in roots and time.monotonic() - stamp < KNOWN_TTL:
        return real
    roots = frozenset(os.path.normcase(h["root"]) for h in known_houses(scan_dirs) if not h.get("missing"))
    _known = (time.monotonic(), roots)
    if os.path.normcase(real) not in roots:
        raise CockpitError(f"{root} is not a house this seat knows; open a session in it, or keep it in a "
                           "scanned folder")
    return real


# ---- reading through the CLI -------------------------------------------------------------------------------------

_cache: dict[tuple[str, bool, tuple[str, ...]], tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _argv(args: tuple[str, ...]) -> list[str]:
    """The argv handed to run_cli. Free text follows a `--` terminator (plan_act puts it there), so a title such as
    `--help` is a title. The CLI reads a last `--json` as the global flag even after the terminator, which is where a
    run_cli that appends it puts it, so the terminator is passed through unchanged."""
    return list(args)


def cli(root: str, *args: str, operator: bool, ttl: float = 0.0, stdin_text: str | None = None,
        timeout: float = 25.0) -> dict:
    """One CLI verb's JSON, `{"ok": false, "error": ...}` on any failure. `ttl` reuses an answer that young.

    `operator` is required: True runs the verb as the person at the desktop (the agent marker dropped), False as the
    agent. Reads pass False; nothing defaults to the operator's authority."""
    key = (root, bool(operator), tuple(args))
    if ttl > 0:
        with _cache_lock:
            hit = _cache.get(key)
            if hit and time.monotonic() - hit[0] < ttl:
                return hit[1]
    try:
        result = run_cli(_argv(tuple(args)), root, operator=operator, stdin_text=stdin_text, timeout=timeout)
        data = dict(result.data)
        data.setdefault("exit", result.exit)
    except NodeMissing:
        data = {"ok": False, "error": "Node.js (22.13 or later) was not found; the house cannot be read"}
    except CliFailed as error:
        data = {"ok": False, "error": str(error)}
    if ttl > 0:
        with _cache_lock:
            _cache[key] = (time.monotonic(), data)
    return data


def forget_cache(root: str, keep: tuple[tuple[str, ...], ...] = ()) -> None:
    """Drops the cached answers for `root`, except the verbs in `keep` (slow reads an act cannot change)."""
    with _cache_lock:
        for key in [k for k in _cache if k[0] == root and not any(k[2][: len(p)] == p for p in keep)]:
            del _cache[key]


def _git(root: str, *args: str, timeout: float = 10) -> str | None:
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        done = subprocess.run(["git", "-C", root, *args], capture_output=True, encoding="utf-8", errors="replace",
                              timeout=timeout, creationflags=flags, check=False, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode == 0 else None


def _git_run(root: str, *args: str, timeout: float = 30) -> tuple[bool, str]:
    """A git command that writes: whether it succeeded, and what it said."""
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        done = subprocess.run(["git", "--literal-pathspecs", "-C", root, *args], capture_output=True, encoding="utf-8",
                              errors="replace", timeout=timeout, creationflags=flags, check=False,
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    said = (done.stderr.strip() or done.stdout.strip()).splitlines()
    return done.returncode == 0, (said[-1] if said else "")


def _status(root: str) -> tuple[str, dict[str, str]] | None:
    """The house's uncommitted paths (relative to the repository's top, as git names them) with their two status
    letters, and that top folder; None when the house is not in a git repository. Only paths inside the house are
    listed, so nothing outside it is ever counted or committed."""
    top = _toplevel(root)
    if top is None:
        return None
    out = _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".")
    if out is None:
        return None
    entries: dict[str, str] = {}
    parts = out.split("\0")
    k = 0
    while k < len(parts):
        entry = parts[k]
        k += 1
        if len(entry) < 4:
            continue
        letters, path = entry[:2], entry[3:]
        entries[path] = letters
        if letters[0] in "RC" and k < len(parts):
            entries[parts[k]] = letters  # a rename names the old path next; both sides belong to the change
            k += 1
    return top, entries


_tops: dict[str, str] = {}


def _toplevel(root: str) -> str | None:
    """The top folder of the git repository holding the house (cached once found), or None outside git."""
    if root in _tops and os.path.isdir(os.path.join(_tops[root], ".git")):
        return _tops[root]
    top = _git(root, "rev-parse", "--show-toplevel")
    if top is None:
        return None
    _tops[root] = os.path.normpath(top.strip())
    return _tops[root]


def _fingerprint(top: str, path: str) -> str:
    full = os.path.join(top, path)
    try:
        size = os.path.getsize(full)
        if size > 8 * 1024 * 1024:
            return f"big:{size}:{os.path.getmtime(full)}"
        with open(full, "rb") as handle:
            return hashlib.sha1(handle.read()).hexdigest()
    except OSError:
        return "gone"


ORG_PREFIXES = ("tasks/", "inbox/", "knowledge/", "reminders/", "proposals/", "projects/", "principles/", "charter/",
                "reflexes/", "state/", "forge/", "rooms/", ".house/generated/")
ORG_FILES = ("AGENTS.md", "voice.md", "curation.md")


def _house_relative(root: str, top: str, path: str) -> str:
    try:
        return os.path.relpath(os.path.join(top, path), root).replace(os.sep, "/")
    except ValueError:
        return path


def _committable(root: str, top: str, entries: Mapping[str, str]) -> list[str]:
    """The uncommitted paths `record.commit` takes: the org folders and the generated surfaces, never house.toml or
    anything else the operator keeps in the house."""
    out = []
    for path in entries:
        rel = _house_relative(root, top, path)
        if rel in ORG_FILES or rel.startswith(ORG_PREFIXES):
            out.append(path)
    return sorted(out)


def git_info(root: str, commits: int = 12) -> dict:
    found = _status(root)
    if found is None:
        return {"ok": False}
    top, entries = found
    head = _git(root, "status", "--porcelain=v1", "--branch", "--untracked-files=no", "--", ".") or ""
    first = head.splitlines()[0][3:] if head.startswith("## ") else ""
    branch, _, tracking = first.partition("...")
    ahead = re.search(r"ahead (\d+)", tracking)
    behind = re.search(r"behind (\d+)", tracking)
    log = _git(root, "log", f"-{commits}", "--format=%h%x1f%an%x1f%aI%x1f%s") or ""
    rows = []
    for line in log.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 4:
            rows.append({"sha": parts[0], "author": parts[1], "at": parts[2], "subject": parts[3]})
    remote = (_git(root, "remote") or "").split()
    dirty = sorted(_house_relative(root, top, p) for p in entries)
    return {
        "ok": True,
        "branch": (branch or "(detached)").replace("No commits yet on ", ""),
        "upstream": tracking.split(" ")[0] if tracking else None,
        "ahead": int(ahead[1]) if ahead else 0,
        "behind": int(behind[1]) if behind else 0,
        "dirty": dirty[:50],
        "dirty_count": len(entries),
        "committable": len(_committable(root, top, entries)),
        "remotes": remote,
        "commits": rows,
    }


def _generated(root: str, name: str) -> str | None:
    path = os.path.join(root, ".house", "generated", name)
    try:
        return read_text(path)
    except OSError:
        return None


def kernel(root: str) -> dict:
    text = _generated(root, "kernel.md")
    try:
        manifest = json.loads(_generated(root, "manifest.json") or "{}")
    except ValueError:
        manifest = {}
    surfaces = _table(manifest, "surfaces") if isinstance(manifest, dict) else {}
    body = text.split("\n", 2)[2] if text and text.count("\n") >= 2 else (text or "")
    size = _table(surfaces, "kernel")
    return {
        "text": body.strip(),
        "chars": size["chars"] if isinstance(size.get("chars"), int) else len(body.strip()),
        "cap": size.get("cap") or KERNEL_CAP,
        "surfaces": surfaces,
        "compiled": text is not None,
    }


_HEADING = re.compile(r"^#{1,4}\s+(?:[A-Za-z0-9._-]+\s*:\s*)?(.+?)\s*$")


def proposal_view(p: Mapping[str, Any]) -> dict:
    """A proposal as a person reads it: its name (from `### mark : Name`), the occasion that called for it, its body
    without the frontmatter, and the CLI's sizes."""
    out = {k: v for k, v in p.items() if k != "text"}
    text = str(p.get("text") or "")
    front, body = _split_frontmatter(text)
    occasion = ""
    for line in front.splitlines():
        m = re.match(r"^occasion:\s*(.*)$", line)
        if m:
            occasion = m[1].strip().strip('"').strip("'")
    lines = body.strip().splitlines()
    title = ""
    if lines:
        m = _HEADING.match(lines[0])
        if m:
            title = m[1].strip()
            lines = lines[1:]
    slug = str(p.get("id") or "").split("/", 1)[-1]
    out.update(
        title=title or slug.replace("-", " ").strip().capitalize(),
        occasion=occasion,
        body="\n".join(lines).strip(),
    )
    return out


def overview(root: str) -> dict:
    """Everything the House page's first screen draws, read in parallel. A read: it registers nothing."""
    root = checked_root(root)
    jobs = {
        "status": lambda: cli(root, "status", ttl=3, operator=False),
        "tasks": lambda: cli(root, "task", "list", ttl=3, operator=False),
        "inbox": lambda: cli(root, "inbox", "list", ttl=3, operator=False),
        "reminders": lambda: cli(root, "remind", "list", ttl=3, operator=False),
        "proposals": lambda: cli(root, "adopt", ttl=3, operator=False),
        "fresh": lambda: cli(root, "compile", "--check", ttl=10, operator=False),
        "doctor": lambda: cli(root, "doctor", "--quick", ttl=30, operator=False),
        "rooms": lambda: cli(root, "rooms", "status", ttl=60, operator=False),
        "git": lambda: git_info(root),
        "kernel": lambda: kernel(root),
    }
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {name: pool.submit(job) for name, job in jobs.items()}
        got = {name: future.result() for name, future in futures.items()}
    proposals = got["proposals"].get("proposed") if got["proposals"].get("ok") else []
    return {
        "ok": True,
        "house": identity(root),
        "counts": got["status"].get("counts") or {},
        "problems": got["status"].get("problems") or [],
        "tasks": got["tasks"].get("items") or [],
        "inbox": got["inbox"].get("items") or [],
        "reminders": got["reminders"].get("items") or [],
        "proposals": [{k: v for k, v in proposal_view(p).items() if k != "body"} for p in proposals or []],
        "fresh": {"ok": got["fresh"].get("ok", False), "stale": got["fresh"].get("stale") or [],
                  "error": got["fresh"].get("error")},
        "doctor": {"exit": got["doctor"].get("exit"), "findings": got["doctor"].get("findings") or [],
                   "error": got["doctor"].get("error")},
        "rooms": {k: got["rooms"].get(k) for k in ("agora", "house", "bearer", "extension")},
        "git": got["git"],
        "kernel": {k: v for k, v in got["kernel"].items() if k != "surfaces"},
        "errors": {name: _message(data.get("error")) for name, data in got.items()
                   if isinstance(data, dict) and data.get("error")},
    }


LISTS = {
    "tasks": ("task", "list"),
    "inbox": ("inbox", "list"),
    "knowledge": ("knowledge", "list"),
    "reminders": ("remind", "list"),
}
EXCERPT_MAX = 220
ENRICH_MAX = 600


def _note_facts(root: str, rel: str) -> dict:
    """A knowledge note's first lines of prose, its tags and how many links it makes, for its card."""
    try:
        path = _inside(root, rel)
        if os.path.getsize(path) > DOC_MAX_BYTES:
            return {}
        front, body = _split_frontmatter(read_text(path))
    except (CockpitError, OSError, UnicodeDecodeError):
        return {}
    tags: list[str] = []
    for line in front.splitlines():
        m = re.match(r"^tags:\s*\[(.*)\]\s*$", line)
        if m:
            tags = [t.strip().strip('"').strip("'") for t in m[1].split(",") if t.strip()]
    prose = []
    for line in body.splitlines():
        text = line.strip()
        if not text or text.startswith(("#", "```", "|", "---")):
            if prose:
                break
            continue
        prose.append(text.lstrip("-*> ").strip())
        if sum(len(p) for p in prose) > EXCERPT_MAX:
            break
    excerpt = WIKILINK.sub(lambda m: m.group(0)[2:-2].split("|")[-1], " ".join(prose))
    excerpt = re.sub(r"[*_`]", "", excerpt)
    if len(excerpt) > EXCERPT_MAX:
        excerpt = excerpt[: EXCERPT_MAX - 1].rsplit(" ", 1)[0] + "…"
    return {"excerpt": excerpt, "tags": tags[:6], "links": len(set(WIKILINK.findall(body)))}


def items(root: str, kind: str, include_all: bool = False) -> dict:
    root = checked_root(root)
    if kind not in LISTS:
        raise CockpitError(f"no list named {kind!r}; lists: {', '.join(LISTS)}")
    args = [*LISTS[kind], *(["--all"] if include_all and kind in ("tasks", "knowledge") else [])]
    data = cli(root, *args, ttl=2, operator=False)
    rows = data.get("items") or []
    if kind == "knowledge":
        rows = [{**row, **_note_facts(root, str(row.get("path") or ""))} if k < ENRICH_MAX and row.get("path") else row
                for k, row in enumerate(rows)]
    return {"ok": data.get("ok", False), "items": rows, "error": data.get("error")}


def rhythm(root: str) -> dict:
    """The house's clock: declared jobs and their health, the OS scheduler entry, forge sessions, reminders, and the
    starter jobs a house can copy in."""
    root = checked_root(root)
    jobs = {
        "jobs": lambda: cli(root, "run", "--status", ttl=5, operator=False),
        "scheduler": lambda: cli(root, "scheduler", "status", ttl=10, operator=False),
        "forge": lambda: cli(root, "forge", "status", ttl=5, operator=False),
        "reminders": lambda: cli(root, "remind", "list", ttl=2, operator=False),
    }
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        got = {name: f.result() for name, f in {n: pool.submit(j) for n, j in jobs.items()}.items()}
    return {
        "ok": True,
        "jobs": got["jobs"].get("jobs") or [],
        "scheduler": {k: v for k, v in got["scheduler"].items() if k not in ("ok", "house")},
        "forge": got["forge"].get("sessions") or [],
        "reminders": got["reminders"].get("items") or [],
        "starters": starter_jobs(),
        "errors": {name: data.get("error") for name, data in got.items() if data.get("error")},
    }


STARTERS_DIR = Path(__file__).resolve().parents[2] / "templates" / "jobs"


def starter_jobs() -> list[dict]:
    """The starter jobs lampstand ships (templates/jobs): each one's name and the house.toml lines that declare it."""
    out = []
    try:
        names = sorted(os.listdir(STARTERS_DIR))
    except OSError:
        return out
    for name in names:
        if name.endswith(".toml"):
            try:
                text = (STARTERS_DIR / name).read_text(encoding="utf-8")
            except OSError:
                continue
            out.append({"name": name[:-5], "toml": text.strip()[:2000]})
    return out


def doctor(root: str, quick: bool = False) -> dict:
    root = checked_root(root)
    data = cli(root, "doctor", *(["--quick"] if quick else []), timeout=60, operator=False)
    return {"ok": data.get("ok", False), "exit": data.get("exit"), "findings": data.get("findings") or [],
            "error": data.get("error")}


def lint(root: str) -> dict:
    """The org lint as a read: whether it ran, and its findings (a finding is not a refusal)."""
    root = checked_root(root)
    data = cli(root, "lint", timeout=60, operator=False)
    findings = data.get("findings")
    ran = isinstance(findings, list)
    return {"ok": ran, "findings": findings if ran else [], "errors": data.get("errors", 0),
            "warnings": data.get("warnings", 0), "info": data.get("info", 0),
            "error": None if ran else _message(data.get("error")) or "lint did not run"}


# ---- documents ---------------------------------------------------------------------------------------------------


def _within(path: str, root: str) -> bool:
    """Whether `path` lies in `root`. False, not an exception, for a path on another drive."""
    try:
        return os.path.commonpath([os.path.normcase(path), os.path.normcase(root)]) == os.path.normcase(root)
    except ValueError:
        return False


def _inside(root: str, rel: str) -> str:
    if not rel or "\x00" in rel:
        raise CockpitError("name a file inside the house")
    try:
        path = os.path.realpath(os.path.join(root, rel))
    except (OSError, ValueError) as error:
        raise CockpitError(f"{rel} is not a path in the house") from error
    if not _within(path, root):
        raise CockpitError(f"{rel} is outside the house")
    parts = Path(os.path.relpath(path, root)).parts
    if parts and parts[0].casefold() == ".git":
        raise CockpitError("the house's .git folder is not shown")
    return path


def _split_frontmatter(text: str) -> tuple[str, str]:
    lines = text.split("\n")
    if not lines or not re.fullmatch(r"---[ \t]*\r?", lines[0]):
        return "", text
    for k in range(1, len(lines)):
        if re.fullmatch(r"---[ \t]*\r?", lines[k]):
            return "\n".join(lines[1:k]), "\n".join(lines[k + 1 :])
    return "", text


def _markdown_files(root: str) -> list[str]:
    out = []
    for directory, folders, files in os.walk(root):
        folders[:] = [f for f in folders if not f.startswith(".") and f not in ("node_modules", "state")]
        for name in files:
            if name.endswith(".md"):
                out.append(os.path.join(directory, name))
                if len(out) >= BACKLINK_SCAN_MAX:
                    return out
    return out


_LINK_SYNTAX = re.compile(r"^\[\[(.*?)\]\]$", re.S)


def link_target(text: str) -> str:
    """The target a wikilink names: `[[a/b#heading|alias]]`, `a/b#heading|alias` and `a/b` all name `a/b`."""
    target = text.strip()
    m = _LINK_SYNTAX.match(target)
    if m:
        target = m[1]
    target = target.split("|", 1)[0].split("#", 1)[0]
    return target.strip().strip("/").replace("\\", "/")


def _resolve(root: str, target: str, stems: Mapping[str, list[str]] | None = None) -> str | None:
    target = link_target(target)
    if not target:
        return None
    for candidate in (target, f"{target}.md"):
        try:
            path = os.path.realpath(os.path.join(root, candidate))
        except (OSError, ValueError):
            continue
        if _within(path, root) and os.path.isfile(path):
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            if not rel.casefold().startswith(".git/"):
                return rel
    stem = target.split("/")[-1]
    hits = (stems or {}).get(stem) if stems is not None else [p for p in _markdown_files(root) if Path(p).stem == stem]
    return os.path.relpath(hits[0], root).replace(os.sep, "/") if hits and len(hits) == 1 else None


def document(root: str, rel: str) -> dict:
    """One file of the house to read: its frontmatter (raw), its body, the wikilinks it makes (each with the file it
    resolves to, or None when it dangles) and the files that link to it. `rel` may also be a [[wikilink]]."""
    root = checked_root(root)
    if rel.strip().startswith("[["):
        found = resolve_link(root, rel)
        if found is None:
            raise CockpitError(f"no note named {link_target(rel)!r} in the house")
        rel = found
    path = _inside(root, rel)
    if not os.path.isfile(path):
        hint = resolve_link(root, rel)
        if hint and hint != rel:
            path = _inside(root, hint)
        else:
            raise CockpitError(f"no file named {rel!r} in the house")
    if not path.endswith(DOC_SUFFIXES):
        raise CockpitError("only text files of the house are shown")
    try:
        size = os.path.getsize(path)
    except OSError as error:
        raise CockpitError(f"{rel}: {error.strerror or error}") from error
    if size > DOC_MAX_BYTES:
        raise CockpitError(f"{rel} is {size} bytes; the reader shows files up to {DOC_MAX_BYTES}")
    text = read_text(path)
    front, body = _split_frontmatter(text) if path.endswith(".md") else ("", text)
    relpath = os.path.relpath(path, root).replace(os.sep, "/")
    stem = Path(relpath).stem
    needles = {stem, relpath, relpath[:-3] if relpath.endswith(".md") else relpath}
    backlinks = []
    files = _markdown_files(root)
    stems: dict[str, list[str]] = {}
    for other in files:
        stems.setdefault(Path(other).stem, []).append(other)
    for other in files:
        if os.path.realpath(other) == path:
            continue
        try:
            content = read_text(other)
        except (OSError, UnicodeDecodeError):
            continue
        targets = {link_target(m) for m in WIKILINK.findall(content)}
        if targets & needles or any(t.split("/")[-1] == stem for t in targets):
            backlinks.append(os.path.relpath(other, root).replace(os.sep, "/"))
    links = sorted({m.strip() for m in WIKILINK.findall(body)})
    return {
        "ok": True,
        "path": relpath,
        "frontmatter": front,
        "body": body,
        "links": links,
        "resolved": {link: _resolve(root, link, stems) for link in links[:400]},
        "backlinks": sorted(backlinks)[:200],
        "bytes": size,
    }


def resolve_link(root: str, target: str) -> str | None:
    """The house-relative path a [[wikilink]] names, or None: an exact path, a path without .md, or a unique stem.
    The brackets, a #heading and an |alias are ignored, so `[[note|the note]]` names `note`."""
    root = checked_root(root)
    return _resolve(root, target)


def constitution(root: str) -> dict:
    """The constitution as files (principles, charter, reflexes, voice and curation), the compiled kernel with its
    budget, the sizes of every compiled surface, and what is proposed for adoption."""
    root = checked_root(root)
    groups = []
    for folder in CONSTITUTION_FOLDERS:
        base = os.path.join(root, folder)
        files = []
        for directory, folders, names in os.walk(base):
            folders.sort()
            for name in sorted(names):
                if name.endswith(".md"):
                    full = os.path.join(directory, name)
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    title = name[:-3]
                    try:
                        _, body = _split_frontmatter(read_text(full))
                        heading = next((line[2:].strip() for line in body.splitlines() if line.startswith("# ")), None)
                        title = heading or title
                        chars = len(body)
                    except (OSError, UnicodeDecodeError):
                        chars = 0
                    files.append({"path": rel, "title": title, "chars": chars})
        groups.append({"name": folder, "files": files})
    loose = []
    for name in CONSTITUTION_FILES:
        full = os.path.join(root, name)
        if os.path.isfile(full):
            loose.append({"path": name, "title": name[:-3], "chars": os.path.getsize(full)})
    groups.append({"name": "voice and curation", "files": loose})
    proposals = cli(root, "adopt", ttl=2, operator=False)
    return {
        "ok": True,
        "house": identity(root),
        "groups": groups,
        "kernel": kernel(root),
        "proposals": [proposal_view(p) for p in proposals.get("proposed") or []],
        "error": _message(proposals.get("error")),
    }


# ---- acts --------------------------------------------------------------------------------------------------------

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ITEM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$")
_PROPOSAL = re.compile(r"^(principle|provision|reflex|update)/[A-Za-z0-9._/-]{1,200}$")


def _message(error: Any) -> str | None:
    """Any error shape the CLI or a host hands back (`"text"`, `{"message": ...}`, `{"error": ...}`) as one line."""
    if error is None or error is False:
        return None
    if isinstance(error, str):
        return error
    if isinstance(error, Mapping):
        for key in ("message", "error", "text", "detail"):
            if error.get(key):
                return _message(error[key])
        return json.dumps(dict(error))[:400]
    return str(error)


def _text(params: Mapping[str, Any], name: str, *, required: bool = True, limit: int = 400) -> str:
    value = params.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise CockpitError(f"{name} is required")
        return ""
    if not isinstance(value, str):
        raise CockpitError(f"{name} must be text")
    value = value.strip()
    if len(value) > limit:
        raise CockpitError(f"{name} is {len(value)} characters; at most {limit}")
    return value


def _flag(name: str, value: str) -> str:
    """A string flag in its inline form (`--name=value`), so a value such as `--help` is never read as a flag."""
    return f"--{name}={value}"


def _item(params: Mapping[str, Any], name: str = "id") -> str:
    value = _text(params, name, limit=200)
    if not _ITEM.match(value) or ".." in value:
        raise CockpitError(f"{name} {value!r} is not an item id")
    return value


def _due(params: Mapping[str, Any], *, required: bool = False) -> list[str]:
    value = _text(params, "due", required=required, limit=10)
    if value and not _DATE.match(value):
        raise CockpitError("due must be a date, YYYY-MM-DD")
    return [_flag("due", value)] if value else []


def plan_act(action: str, params: Mapping[str, Any]) -> tuple[list[str], str | None]:
    """The CLI argv and stdin for one act. Raises CockpitError for an unknown act or a bad parameter.

    Free text is never parsed as a flag: string flags go inline (`--resolution=...`) and a free-text positional (a
    title) follows a `--` terminator after every flag."""
    body = params.get("body")
    if body is not None and not isinstance(body, str):
        raise CockpitError("body must be text")
    body = (body or "").strip()
    if len(body) > 60_000:
        raise CockpitError("body is longer than 60,000 characters")
    with_body = (["--body", "-"], body) if body else ([], None)
    if action == "task.new":
        return ["task", "new", *_due(params), *with_body[0], "--", _text(params, "title", limit=200)], with_body[1]
    if action == "task.set":
        args = ["task", "set", _item(params)]
        if params.get("status"):
            args.append(_flag("status", _text(params, "status", limit=40)))
        if params.get("title"):
            args.append(_flag("title", _text(params, "title", limit=200)))
        if params.get("resolution"):
            args.append(_flag("resolution", _text(params, "resolution")))
        return args + _due(params), None
    if action == "task.done":
        return ["task", "done", _item(params), _flag("resolution", _text(params, "resolution"))], None
    if action == "inbox.new":
        kind = _text(params, "kind", limit=20)
        if kind not in ("idea", "investigation", "decision", "capture"):
            raise CockpitError("kind must be idea, investigation, decision or capture")
        return ["inbox", "new", kind, *with_body[0], "--", _text(params, "title", limit=200)], with_body[1]
    if action == "inbox.set":
        args = ["inbox", "set", _item(params), _flag("status", _text(params, "status", limit=40))]
        if params.get("resolution"):
            args.append(_flag("resolution", _text(params, "resolution")))
        return args, None
    if action == "capture":
        return ["capture", "-"], _text(params, "text", limit=20_000)
    if action == "decide.new":
        return ["decide", "new", *with_body[0], "--", _text(params, "title", limit=200)], with_body[1]
    if action == "decide.resolve":
        args = ["decide", "resolve", _item(params), _flag("resolution", _text(params, "resolution"))]
        if params.get("status"):
            args.append(_flag("status", _text(params, "status", limit=40)))
        return args, None
    if action == "remind.new":
        due = _due(params, required=True)
        return ["remind", "new", *due, *with_body[0], "--", _text(params, "title", limit=200)], with_body[1]
    if action == "remind.done":
        return ["remind", "done", _item(params), _flag("resolution", _text(params, "resolution"))], None
    if action == "knowledge.new":
        return ["knowledge", "new", *with_body[0], "--", _text(params, "title", limit=200)], with_body[1]
    if action in ("adopt", "strike"):
        ids = params.get("ids")
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and _PROPOSAL.match(i) for i in ids):
            raise CockpitError("ids must name proposed items: <kind>/<slug> or update/<path>")
        return ["adopt", _flag("ids" if action == "adopt" else "strike", ",".join(ids))], None
    if action == "compile":
        return ["compile"], None
    if action == "lint":
        return ["lint"], None
    raise CockpitError(f"no act named {action!r}")


ACTS = ("task.new", "task.set", "task.done", "inbox.new", "inbox.set", "capture", "decide.new", "decide.resolve",
        "remind.new", "remind.done", "knowledge.new", "adopt", "strike", "compile", "lint", "record.commit")
# Acts that are the operator's alone, whatever the CLI would say: the cockpit refuses them from an agent.
OPERATOR_ACTS = ("record.commit",)
# Acts that write nothing, so nothing is committed after them.
READ_ACTS = ("lint",)
# Slow reads an org act cannot change; their cached answers survive it.
_KEEP_AFTER_ORG_ACT = (("doctor",), ("rooms",), ("scheduler",), ("run",), ("forge",), ("compile", "--check"))
_STATUS_WORDS = {"active": "Started", "blocked": "Blocked", "open": "Reopened", "dropped": "Dropped", "done": "Done",
                 "adopted": "Adopted", "filed": "Filed", "concluded": "Concluded", "abandoned": "Abandoned",
                 "decided": "Ruled", "superseded": "Superseded", "withdrawn": "Withdrawn"}


def _short(text: str, limit: int = 72) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _title_in(root: str | None, rel: Any) -> str:
    """The `title:` in a house file's frontmatter, or ''."""
    if not root or not isinstance(rel, str) or not rel.endswith(".md"):
        return ""
    try:
        front, _ = _split_frontmatter(read_text(_inside(root, rel)))
    except (CockpitError, OSError, UnicodeDecodeError):
        return ""
    for line in front.splitlines():
        m = re.match(r"^title:\s*(.*)$", line)
        if m:
            return m[1].strip().strip('"').strip("'")
    return ""


def _name_of(data: Mapping[str, Any], params: Mapping[str, Any], root: str | None = None) -> str:
    """The title of the item an act touched: from the CLI's answer when it names one, else from what was asked."""
    for source in (data.get("item"), data):
        if isinstance(source, Mapping) and source.get("title"):
            return str(source["title"])
    for key in ("to", "path", "file", "from"):
        title = _title_in(root, data.get(key))
        if title:
            return title
    if params.get("title"):
        return str(params["title"])
    if params.get("text"):
        return str(params["text"]).splitlines()[0]
    ident = str(params.get("id") or "")
    return ident.split("/")[-1].replace("-", " ") if ident else ""


def describe(action: str, params: Mapping[str, Any], data: Mapping[str, Any], root: str | None = None) -> str:
    """One plain sentence for what an act did, for a commit subject and a toast."""
    name = _short(_name_of(data, params, root))
    status = str(params.get("status") or "")
    if action == "task.new":
        return f"Task: {name}"
    if action == "task.set":
        return f"{_STATUS_WORDS.get(status, 'Changed')}: {name}" if status else f"Changed: {name}"
    if action == "task.done":
        return f"Done: {name}"
    if action == "inbox.new":
        return f"{str(params.get('kind') or 'Item').capitalize()}: {name}"
    if action == "inbox.set":
        return f"{_STATUS_WORDS.get(status, 'Changed')}: {name}"
    if action == "capture":
        return f"Captured: {name}"
    if action == "decide.new":
        return f"Decision opened: {name}"
    if action == "decide.resolve":
        return f"{_STATUS_WORDS.get(status or 'decided', 'Ruled')}: {name}"
    if action == "remind.new":
        return f"Reminder for {params.get('due')}: {name}"
    if action == "remind.done":
        return f"Reminder done: {name}"
    if action == "knowledge.new":
        return f"Note: {name}"
    if action in ("adopt", "strike"):
        ids = ", ".join(str(i) for i in params.get("ids") or [])
        return f"{'Adopted' if action == 'adopt' else 'Struck'}: {ids}"
    if action == "compile":
        return "Compiled the constitution"
    if action == "record.commit":
        return _short(str(params.get("message") or "Record the house"), 120)
    return action


def _head(root: str) -> str | None:
    out = _git(root, "rev-parse", "--short", "HEAD")
    return out.strip() if out else None


def _commit(top: str, paths: list[str], message: str) -> tuple[str | None, str | None]:
    """Commits exactly `paths` (repository-relative) with `message`; the short sha, or None and why not."""
    if not paths:
        return None, None
    ok, said = _git_run(top, "add", "-A", "--", *paths)
    if not ok:
        return None, f"git add: {said}"
    ok, said = _git_run(top, "commit", "-q", "-m", message, "--", *paths)
    if not ok:
        return None, f"git commit: {said or 'refused'}"
    return _head(top), None


def _changed(before: Mapping[str, str], marks: Mapping[str, str], after: Mapping[str, str], top: str) -> list[str]:
    """The paths an act changed: dirty now and clean before, or dirty before with different content now."""
    out = []
    for path in after:
        if path not in before or marks.get(path) != _fingerprint(top, path):
            out.append(path)
    return sorted(out)


def record_commit(root: str, message: str) -> dict:
    """Commits every uncommitted change in the house's org folders and generated surfaces, with the operator's
    message. house.toml and anything else in the house is left as it is."""
    found = _status(root)
    if found is None:
        return {"ok": False, "error": "the house is not a git repository"}
    top, entries = found
    paths = _committable(root, top, entries)
    if not paths:
        return {"ok": True, "text": "Nothing to commit: the record is clean.", "commit": None, "committed": []}
    sha, why = _commit(top, paths, message)
    if sha is None:
        return {"ok": False, "error": why or "nothing was committed"}
    files = [_house_relative(root, top, p) for p in paths]
    return {"ok": True, "text": f"Committed {len(files)} change{'s' if len(files) != 1 else ''} as {sha}: {message}",
            "commit": sha, "committed": files}


def act(root: str, action: str, params: Mapping[str, Any], *, operator: bool) -> dict:
    """Runs one act and returns the CLI's answer, with a plain `text` and, when it wrote anything, `commit`.

    Every act that writes lands as one git commit of exactly the paths it changed (the uncommitted paths of the house
    are read before and after it; a path dirty before is committed only when the act changed its content), so the
    operator's own uncommitted work is never swept in. An act the CLI commits itself (adopt, strike) keeps its
    commit. A house outside git is written and not committed."""
    root = checked_root(root)
    if action in OPERATOR_ACTS and not operator:
        return {"ok": False, "error": {"code": "E_OPERATOR_ONLY", "message": f"{action} is the operator's act"}}
    if action == "record.commit":
        data = record_commit(root, _text(params, "message", limit=200))
        forget_cache(root, keep=_KEEP_AFTER_ORG_ACT)
        return data
    args, stdin_text = plan_act(action, params)
    with _act_lock(root):
        return _act(root, action, params, args, stdin_text, operator=operator)


def committed(root: str, summary: str, run: Callable[[], dict]) -> dict:
    """Runs `run` (a write outside the act list, such as a proposal) and commits exactly the paths it changed, as an
    act would."""
    root = checked_root(root)
    with _act_lock(root):
        found = _status(root)
        marks = {p: _fingerprint(found[0], p) for p in found[1]} if found else {}
        data = dict(run())
        if data.get("ok") is not False and not data.get("refused") and found:
            top, before = found
            after = _status(root)
            paths = _changed(before, marks, after[1], top) if after else []
            sha, why = _commit(top, paths, summary) if paths else (None, None)
            data["commit"] = sha
            if why:
                data["commit_error"] = why
        forget_cache(root, keep=_KEEP_AFTER_ORG_ACT)
        return data


_act_locks: dict[str, threading.Lock] = {}
_act_locks_guard = threading.Lock()


def _act_lock(root: str) -> threading.Lock:
    """One act at a time per house in this process, so two acts never commit each other's paths."""
    with _act_locks_guard:
        return _act_locks.setdefault(os.path.normcase(root), threading.Lock())


def _act(root: str, action: str, params: Mapping[str, Any], args: list[str], stdin_text: str | None, *,
         operator: bool) -> dict:
    writes = action not in READ_ACTS
    found = _status(root) if writes else None
    head = _head(root) if found and action in ("adopt", "strike") else None
    marks = {p: _fingerprint(found[0], p) for p in found[1]} if found else {}
    data = cli(root, *args, operator=operator, stdin_text=stdin_text, timeout=60)
    data = dict(data)
    if data.get("ok") is False:
        message = _message(data.get("error")) or _message(data.get("text")) or f"{action} was refused"
        # The CLI names its flags; here the reason is read by a person or a model, who give a resolution, not a flag.
        data["message"] = re.sub(r'--resolution\s*("<([^>]*)>")?', lambda m: f"a resolution ({m.group(2)})" if m.group(2) else "a resolution", message)
    elif writes:
        summary = describe(action, params, data, root)
        if not str(data.get("text") or "").strip():
            data["text"] = summary
        data["summary"] = summary
        if found:
            top, before = found
            after = _status(root)
            paths = _changed(before, marks, after[1], top) if after else []
            sha, why = _commit(top, paths, summary) if paths else (None, None)
            if sha is None and not why and head:
                moved = _head(root)
                sha = moved if moved and moved != head else None
            data["commit"] = sha
            data["committed"] = [_house_relative(root, top, p) for p in paths]
            if why:
                data["commit_error"] = why
    if action in ("compile", "adopt", "strike"):
        forget_cache(root)
    else:
        forget_cache(root, keep=_KEEP_AFTER_ORG_ACT)
    return data


def resolve_for(cwd: str, workspace: bool = True) -> str | None:
    try:
        return resolve_house(cwd, workspace=workspace).root
    except LampstandError:
        return None
