"""The Hermes adapter (DESIGN §10, Hermes column).

- Kernel: the `lampstand-kernel` prompt section carries K, or a one-line pointer when the house's AGENTS.md region
  will load in this session (Hermes loads one kind of context file, so a shadowing file means K must come from here).
- Dynamic orientation: the first turn's `pre_llm_call` runs `lampstand status --orient`.
- Worker: the `lampstand_delegate` tool composes W with `agents/<role>.md` into a Hermes subagent launch.
- Maintenance gate: `pre_verify` asks `lampstand gate` with the paths the session changed.

register() only hands callables to Hermes: it runs in every Hermes process at startup, so it reads no house, spawns
nothing and opens no socket. Work happens when Hermes calls back, and Node is spawned only at those bounded points.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections import OrderedDict
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .context import house_region_loads
from .node import CliFailed, NodeMissing, run_cli
from .projection import ProjectionError, projection_path, read_projection
from .root import LampstandError, Resolution, read_text, resolve_house

logger = logging.getLogger("lampstand")

SECTION_ID = "lampstand-kernel"
# Hermes refuses a prompt section whose stripped content is longer than this, and allows no larger cap.
SECTION_MAX_CHARS = 4000
KERNEL_PROJECTION = "kernel.md"
ROUTER_PROJECTION = "router.hermes.md"
WORKER_PROJECTION = "worker.hermes.md"

AGENTS_DIR = Path(__file__).resolve().parents[2] / "agents"
ROLE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DELEGATE_TOOL = "lampstand_delegate"
# The subagent lifecycle's own request limits; checked here so an oversized launch fails with a lampstand message.
DELEGATE_GOAL_MAX_CHARS = 16_000
DELEGATE_CONTEXT_MAX_CHARS = 32_000

SUBAGENT = "subagent"
# Platforms whose sessions have a workspace. Messaging platforms and cron do not, so only they may fall back to
# default_house (DESIGN §2, house resolution step 3).
WORKSPACE_PLATFORMS = frozenset({"", "cli", "tui", "desktop", "acp", SUBAGENT})
# Per-session gate memory is bounded: a long-lived gateway sees an unbounded number of sessions.
SESSIONS_REMEMBERED = 256

NODE_MISSING = (
    "lampstand: Node.js (>= 22.13) was not found on PATH or at $HERMES_HOME/node, so orientation and the maintenance "
    "gate are off; install Node and restart Hermes."
)


def has_workspace(platform: str) -> bool:
    return platform in WORKSPACE_PLATFORMS


def _fit_section(*candidates: tuple[str, ...]) -> str:
    """The first candidate whose lines fit the section cap; "" when none does (Hermes would skip it anyway)."""
    for parts in candidates:
        text = "\n".join(part for part in parts if part)
        if len(text) <= SECTION_MAX_CHARS:
            return text
    return ""


def kernel_section(root: str, cwd: str) -> str:
    """The `lampstand-kernel` section text for a session in `cwd` whose house is at `root`."""
    if house_region_loads(root, cwd):
        return (
            f"lampstand: the house at {root} loads from its AGENTS.md region (the kernel and the router sections it "
            "holds) in this session."
        )
    try:
        projection = read_projection(root, KERNEL_PROJECTION)
    except ProjectionError:
        return ""
    kernel = projection.body.split("\n", 1)[1].strip() if "\n" in projection.body else ""
    pointer = (
        f"lampstand: the AGENTS.md region of the house at {root} does not load in this session; read "
        f"{projection_path(root, ROUTER_PROJECTION)} for principle detail, charter, reflexes and voice."
    )
    if not kernel:
        return pointer
    return _fit_section((projection.marker, kernel, pointer), (kernel, pointer), (kernel,))


FENCE = re.compile(r"---[ \t]*")


def strip_frontmatter(text: str) -> str:
    """The Markdown body after a leading `---` block, split where core/lib/frontmatter.js splits it: a fence is a
    line of `---` with optional trailing blanks. The block is removed whole and never read: the Python side of
    lampstand does not parse YAML, and no construct of the subset (block scalars and flow collections included) can
    hold a line that is a fence. An unclosed block is left as text."""
    lines = text.split("\n")
    if not FENCE.fullmatch(lines[0]):
        return text
    for k in range(1, len(lines)):
        if FENCE.fullmatch(lines[k]):
            return "\n".join(lines[k + 1 :])
    return text


def available_roles() -> list[str]:
    try:
        names = os.listdir(AGENTS_DIR)
    except OSError:
        return []
    return sorted(n[: -len(".md")] for n in names if n.endswith(".md") and ROLE_NAME.match(n[: -len(".md")]))


def delegate_schema(roles: list[str]) -> dict:
    role: dict[str, Any] = {"type": "string", "description": "The lampstand role whose brief the subagent follows."}
    if roles:
        role["enum"] = roles
    return {
        "name": DELEGATE_TOOL,
        "description": (
            "Delegate one bounded task to a subagent that works under a lampstand role brief and the house's worker "
            "constitution (its kernel and the reflexes scoped to Hermes). Returns the subagent's summary."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "role": role,
                "goal": {
                    "type": "string",
                    "description": "What the subagent should accomplish; specific and self-contained.",
                },
                "context": {
                    "type": "string",
                    "description": "Background the subagent needs: file paths, constraints, decisions already made.",
                },
            },
            "required": ["role", "goal"],
        },
    }


def _cli_error(data: Mapping[str, Any]) -> str:
    error = data.get("error")
    if isinstance(error, dict):
        return f"{error.get('code', 'E_INTERNAL')}: {error.get('message', '')}"
    return "the CLI reported a failure without an error"


def _remember(store: OrderedDict, key: str) -> None:
    store.move_to_end(key)
    while len(store) > SESSIONS_REMEMBERED:
        store.popitem(last=False)


class Adapter:
    """The callbacks Hermes invokes. One instance per loaded plugin; safe across concurrent gateway sessions."""

    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx
        self._lock = threading.Lock()
        self._node_reported = False
        self._changed: OrderedDict[str, set[str]] = OrderedDict()
        self._reminded: OrderedDict[str, bool] = OrderedDict()

    # Session facts (present from the plugin.yaml floor). A surface that reports no cwd falls back to the process's.

    def _session_cwd(self) -> str:
        return self._ctx.session_cwd() or os.getcwd()

    def _session_platform(self) -> str:
        return self._ctx.session_surface() or ""

    def _node_notice(self) -> str | None:
        with self._lock:
            if self._node_reported:
                return None
            self._node_reported = True
        return NODE_MISSING

    # The kernel section.

    def section(self, info: Mapping[str, Any]) -> str:
        platform = str(info.get("platform") or "")
        if platform == SUBAGENT:
            # A lampstand subagent receives K inside W from lampstand_delegate; a second copy here would double it.
            return ""
        cwd = str(info.get("cwd") or "") or os.getcwd()
        try:
            found = resolve_house(cwd, workspace=has_workspace(platform))
        except LampstandError:
            return ""
        if found.root is None:
            return ""
        return kernel_section(found.root, cwd)

    # The first turn's orientation.

    def _kernel_notices(self, root: str, cwd: str) -> tuple[list[str], str | None]:
        """Notices about the kernel this session carries, and separately the stale notice, which the CLI's own
        STALE_PROJECTION line makes redundant."""
        if house_region_loads(root, cwd):
            return [], None
        try:
            projection = read_projection(root, KERNEL_PROJECTION)
        except ProjectionError as error:
            return [str(error)], None
        notices = []
        if kernel_section(root, cwd) == "":
            notices.append(
                f"lampstand: the kernel is longer than Hermes's {SECTION_MAX_CHARS}-character prompt section and was "
                "not loaded; shorten the purpose, principles or ask-first lines and run `lampstand compile`."
            )
        return notices, projection.notice

    def pre_llm_call(self, is_first_turn: bool = False, platform: str = "", **_: Any) -> dict | None:
        if not is_first_turn or platform == SUBAGENT:
            return None
        cwd = self._session_cwd()
        try:
            found = resolve_house(cwd, workspace=has_workspace(platform or self._session_platform()))
        except LampstandError as error:
            return {"context": f"lampstand: {error}"}
        if found.root is None:
            # Outside a house the plugin is silent: a global install would otherwise speak in every session.
            return None
        notices, stale = self._kernel_notices(found.root, cwd)
        orientation = ""
        try:
            result = run_cli(["status", "--orient"], found.root)
        except NodeMissing:
            missing = self._node_notice()
            if missing:
                notices.append(missing)
        except CliFailed as error:
            notices.append(f"lampstand: orientation failed: {error}")
        else:
            if result.data.get("ok"):
                orientation = str(result.data.get("text") or "")
                problems = result.data.get("problems") or []
                if any(isinstance(p, dict) and p.get("code") == "STALE_PROJECTION" for p in problems):
                    stale = None
            else:
                notices.append(f"lampstand: orientation failed: {_cli_error(result.data)}")
        if stale:
            notices.append(stale)
        lines = [f"lampstand house {found.root}:", *notices, *([orientation] if orientation else [])]
        return {"context": "\n".join(lines)}

    # The maintenance gate.

    def pre_verify(
        self, session_id: str = "", platform: str = "", changed_paths: list | None = None, **_: Any
    ) -> dict | None:
        if platform == SUBAGENT:
            return None
        cwd = self._session_cwd()
        fresh = {os.path.normpath(os.path.join(cwd, p)) for p in changed_paths or [] if isinstance(p, str) and p}
        with self._lock:
            changed = self._changed.setdefault(session_id, set())
            changed.update(fresh)
            _remember(self._changed, session_id)
            paths = sorted(changed)
        if not paths:
            return None
        try:
            found = resolve_house(cwd, workspace=has_workspace(platform or self._session_platform()))
        except LampstandError as error:
            logger.warning("lampstand gate skipped: %s", error)
            return None
        if found.root is None:
            return None
        try:
            result = run_cli(["gate", *paths], found.root)
        except NodeMissing:
            if self._node_notice():
                logger.warning(NODE_MISSING)
            return None
        except CliFailed as error:
            logger.warning("lampstand gate failed: %s", error)
            return None
        data = result.data
        if not data.get("ok"):
            logger.warning("lampstand gate failed: %s", _cli_error(data))
            return None
        owed = [item for item in data.get("owed") or [] if isinstance(item, dict)]
        listing = "; ".join(f"{item.get('id')}: {item.get('owed')} (in {item.get('folder')})" for item in owed)
        if data.get("block"):
            return {
                "action": "continue",
                "message": f"lampstand gate: {data['block']}. Record it in the house before finishing.",
            }
        if owed and data.get("mode") == "remind":
            with self._lock:
                if session_id in self._reminded:
                    return None
                self._reminded[session_id] = True
                _remember(self._reminded, session_id)
            return {
                "action": "continue",
                "message": f"lampstand reminder: this session's changes leave the house owed {listing}. Record "
                "what applies, or say why none does, then finish.",
            }
        return None

    # The worker: delegation under a role brief and W.

    def delegate(self, args: Mapping[str, Any], **_: Any) -> str:
        role = args.get("role")
        goal = args.get("goal")
        extra = args.get("context") or ""
        roles = available_roles()
        if not isinstance(role, str) or role not in roles:
            return _tool_result(False, error=f"unknown role {role!r}; roles: {', '.join(roles) or 'none shipped'}")
        if not isinstance(goal, str) or not goal.strip():
            return _tool_result(False, error="goal must be a non-empty string")
        if not isinstance(extra, str):
            return _tool_result(False, error="context must be a string")

        notices: list[str] = []
        worker = ""
        try:
            found = resolve_house(self._session_cwd(), workspace=has_workspace(self._session_platform()))
        except LampstandError as error:
            found = Resolution("dormant", None)
            notices.append(f"lampstand: {error}")
        if found.root is not None:
            try:
                projection = read_projection(found.root, WORKER_PROJECTION)
            except ProjectionError as error:
                notices.append(str(error))
            else:
                worker = projection.body.strip()
                # The subagent works in the same folder, so it loads the house's AGENTS.md region too, and that
                # region carries K: W goes without it, as the OMP adapter does, so K is never loaded twice.
                if house_region_loads(found.root, self._session_cwd()):
                    worker = _without_kernel(found.root, worker)
                if projection.notice:
                    notices.append(projection.notice)
        brief = strip_frontmatter(read_text(str(AGENTS_DIR / f"{role}.md"))).strip()
        context = "\n\n".join(part for part in (worker, brief, extra.strip()) if part)
        if len(goal) > DELEGATE_GOAL_MAX_CHARS:
            return _tool_result(False, error=f"goal is {len(goal)} characters; the limit is {DELEGATE_GOAL_MAX_CHARS}")
        if len(context) > DELEGATE_CONTEXT_MAX_CHARS:
            return _tool_result(
                False,
                error=f"the composed context (worker projection, role brief, your context) is {len(context)} "
                f"characters; the limit is {DELEGATE_CONTEXT_MAX_CHARS}; shorten your context",
            )

        service = getattr(self._ctx, "subagent_lifecycle", None)
        if service is None:
            return _tool_result(False, error="this Hermes offers plugins no subagent lifecycle")
        try:
            handle = service.launch({"goal": goal, "context": context, "role": "leaf"})
            service.wait(handle)
            result = service.result(handle)
        except Exception as error:  # the host's lifecycle errors are its own types, which a plugin does not import
            return _tool_result(False, error=f"delegation failed: {error}", notices=notices)
        state = getattr(result, "terminal_state", None)
        state = str(getattr(state, "value", state))
        return _tool_result(
            state == "SUCCEEDED",
            role=role,
            state=state,
            summary=getattr(result, "summary", None),
            error=getattr(result, "error_message", None),
            notices=notices,
        )


def _without_kernel(root: str, worker: str) -> str:
    """W without K: its marker line, then its sections. K is cut by the exact text of kernel.md, which the compiler
    guarantees every projection opens with; a worker that does not open with it is passed whole."""
    try:
        kernel_projection = read_projection(root, KERNEL_PROJECTION)
    except ProjectionError:
        return worker
    body = kernel_projection.body
    kernel = body.split("\n", 1)[1].strip() if "\n" in body else ""
    marker, _, rest = worker.partition("\n")
    if not kernel or not rest.startswith(kernel):
        return worker
    return "\n".join(part for part in (marker, rest[len(kernel) :].strip()) if part)


def _tool_result(ok: bool, **fields: Any) -> str:
    return json.dumps({"ok": ok, **{k: v for k, v in fields.items() if v not in (None, [])}}, ensure_ascii=False)


def register(ctx: Any) -> None:
    # Marks the agent's environment: Hermes's terminal tool passes through every name that is not a credential, and
    # `lampstand adopt` refuses principles and provisions from a shell that carries this one.
    os.environ["LAMPSTAND_AGENT"] = "hermes"
    adapter = Adapter(ctx)
    ctx.register_system_prompt_section(SECTION_ID, adapter.section, max_chars=SECTION_MAX_CHARS)
    ctx.register_hook("pre_llm_call", adapter.pre_llm_call)
    ctx.register_hook("pre_verify", adapter.pre_verify)
    ctx.register_tool(
        name=DELEGATE_TOOL,
        toolset="lampstand",
        schema=delegate_schema(available_roles()),
        handler=adapter.delegate,
        description="Delegate a bounded task to a subagent under a lampstand role and the house's worker projection.",
    )
