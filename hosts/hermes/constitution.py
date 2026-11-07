"""What an open chat learns when its house's constitution changes under it.

Hermes renders the `lampstand-kernel` prompt section, and loads the house's AGENTS.md region, once per session: the
system prompt is frozen for the prompt cache and rebuilt only when the session is compacted. A principle or provision
adopted while a chat is open would otherwise reach only chats started after it. So the adapter remembers, per session,
the constitution lines the session's prompt was built with, and on each later turn compares them with the house's
compiled router projection (K, then the charter with its provisions, then the reflexes). When they differ, that turn
carries one short note naming what is now in force and what no longer is; Hermes keeps a hook's context with the
turn's user message and replays it on every later turn, so the note is given once and stays.

The baselines are kept under the profile's Hermes home (`lampstand/constitution-seen.json`), so a restarted gateway
still knows what a resumed chat was built with.
"""

from __future__ import annotations

import time

from .projection import ProjectionError, projection_path, read_projection
from .store import read_json, state_dir, update_json

SEEN_FILE = "constitution-seen.json"
SEEN_MAX = 200
ROUTER = "router.hermes.md"
KERNEL = "kernel.md"
# Sections of the router whose lines are the constitution a chat works under. Principle detail elaborates the
# kernel's one line per principle, and voice is style, so a change there is not announced.
SECTIONS = ("Charter", "Reflexes")
NOTE_CHARS = 1600


def constitution_lines(root: str) -> list[str] | None:
    """The non-blank lines of the house's compiled constitution as a chat carries it (K, the charter, the reflexes),
    in order; None when the house has no readable projection."""
    for name in (ROUTER, KERNEL):
        try:
            body = read_projection(root, name).body
        except ProjectionError:
            continue
        lines = body.split("\n")[1:]  # the marker line names the projection, not the constitution
        out: list[str] = []
        section: str | None = None
        for line in lines:
            if line.startswith("## "):
                section = line[3:].strip()
                continue
            if section is not None and section not in SECTIONS:
                continue
            text = line.strip()
            if text:
                out.append(text)
        return out
    return None


def _path():
    return state_dir() / SEEN_FILE


def remember(session_id: str, root: str, lines: list[str] | None = None) -> None:
    """Records the constitution `session_id`'s prompt was built with (now, unless `lines` is given)."""
    if not session_id:
        return
    lines = constitution_lines(root) if lines is None else lines
    if lines is None:
        return

    def put(data: dict) -> None:
        sessions = data.setdefault("sessions", {})
        sessions.pop(session_id, None)
        sessions[session_id] = {"root": root, "lines": lines, "at": int(time.time())}
        while len(sessions) > SEEN_MAX:
            sessions.pop(next(iter(sessions)))
        data["v"] = 1

    update_json(_path(), {}, put)


def seen(session_id: str) -> dict | None:
    data = read_json(_path(), {})
    sessions = data.get("sessions") if isinstance(data, dict) else None
    entry = sessions.get(session_id) if isinstance(sessions, dict) else None
    return entry if isinstance(entry, dict) and isinstance(entry.get("lines"), list) else None


def _clip(lines: list[str], budget: int) -> tuple[list[str], bool]:
    out: list[str] = []
    used = 0
    previous = ""
    for line in lines:
        text = line[4:] if line.startswith("### ") else line
        # A provision whose text only restates its title is shown once.
        if text.rstrip(".") == previous.rstrip("."):
            continue
        previous = text
        if used + len(text) > budget:
            return out, True
        out.append(f"  {text}")
        used += len(text) + 3
    return out, False


def change_note(root: str, before: list[str], after: list[str]) -> str:
    """The note for a chat whose prompt carries `before` while the house now holds `after`; "" when they agree."""
    old, new = set(before), set(after)
    added = [line for line in after if line not in old]
    removed = [line for line in before if line not in new]
    if not added and not removed:
        return ""
    out = [
        "lampstand: this house's constitution changed after this chat began. What changed binds you from this turn "
        "on, over anything earlier in this chat's instructions that it contradicts."
    ]
    cut = False
    if added:
        shown, cut = _clip(added, NOTE_CHARS)
        out += ["Now in force (adopted since this chat began):", *shown]
    if removed:
        shown, more = _clip(removed, max(200, NOTE_CHARS // 3))
        cut = cut or more
        out += ["No longer in force:", *shown]
    tail = " (read it for the rest)." if cut else "."
    out.append(f"The whole constitution: {projection_path(root, ROUTER)}{tail}")
    return "\n".join(out)


def turn_note(session_id: str, root: str) -> str:
    """The note for this turn of `session_id` in the house at `root`, "" when nothing changed since its prompt was
    built (or since the last note). A session with no baseline (one the plugin first sees mid-conversation) is
    recorded as it stands, with no note."""
    if not session_id:
        return ""
    current = constitution_lines(root)
    if current is None:
        return ""
    entry = seen(session_id)
    if entry is None or entry.get("root") != root:
        remember(session_id, root, current)
        return ""
    note = change_note(root, [str(line) for line in entry["lines"]], current)
    if note:
        remember(session_id, root, current)
    return note
