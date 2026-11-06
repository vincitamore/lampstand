"""Backend routes for the desktop's House page: ``/api/plugins/lampstand/``.

Hermes imports this file inside the gateway process when the plugin is in ``plugins.enabled``. It drives the same
modules the agent's tools use (hosts/hermes/cockpit.py and agora.py), found in the package Hermes already loaded, so
the page and the agent read one truth from the house's files and the lampstand CLI.

Acts made here are the person's at the desktop: they run without the agent marker, so the operator's verbs (adopt and
strike) are not refused as an agent's. Every act is one entry of a closed list (cockpit.ACTS); nothing here runs an
arbitrary command, reads outside a house, or writes agora's config.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query

_PACKAGE_DIR = Path(__file__).resolve().parents[1]
_ALIAS = "hermes_lampstand_cockpit"


def _package() -> ModuleType:
    """The plugin package: the copy Hermes already loaded (so the room watch is the agent half's own), else one
    loaded from this folder."""
    init = (_PACKAGE_DIR / "__init__.py").resolve()
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if file and name.count(".") <= 1 and Path(file).resolve() == init:
            return module
    if _ALIAS not in sys.modules:
        spec = importlib.util.spec_from_file_location(_ALIAS, init, submodule_search_locations=[str(_PACKAGE_DIR)])
        if spec is None or spec.loader is None:
            raise RuntimeError("cannot load the lampstand plugin package")
        module = importlib.util.module_from_spec(spec)
        sys.modules[_ALIAS] = module
        spec.loader.exec_module(module)
    return sys.modules[_ALIAS]


def _mod(name: str) -> Any:
    return importlib.import_module(f"{_package().__name__}.hosts.hermes.{name}")


def _settings() -> dict:
    try:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly() or {}
    except Exception:
        return {}
    entry = ((config.get("plugins") or {}).get("entries") or {}).get("lampstand") or {}
    if not isinstance(entry, dict):
        return {}
    raw = entry.get("settings")
    settings: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
    settings["allow_gateway_injection"] = entry.get("allow_gateway_injection") is True
    return settings


def _house_dirs(settings: dict) -> list[str]:
    value = settings.get("houses_dir") or ""
    dirs = [d.strip() for d in str(value).replace(";", ",").split(",") if d.strip()]
    home = os.path.expanduser("~")
    # lampstand's docs plant houses under ~/houses or ~/Documents/houses; only folders that exist are scanned.
    return dirs or [os.path.join(home, "houses"), os.path.join(home, "Documents", "houses")]


def _guard(call):
    cockpit = _mod("cockpit")
    try:
        return call()
    except cockpit.CockpitError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


router = APIRouter()


@router.get("/seat")
def seat(cwd: str = Query("")) -> dict[str, Any]:
    """What this seat has: houses, agora, Node, whether room wakes are granted."""
    cockpit, agora, node = _mod("cockpit"), _mod("agora"), _mod("node")
    settings = _settings()
    focus = cockpit.resolve_for(cwd) if cwd else None
    install = agora.find_agora(settings.get("agora_checkout") or None)
    return {
        "ok": True,
        "houses": cockpit.known_houses(_house_dirs(settings), [focus] if focus else []),
        "focus": focus,
        "houses_dirs": _house_dirs(settings),
        "node": node.find_node() is not None,
        "agora": install.as_dict(),
        "wakes": {"granted": settings.get("allow_gateway_injection", False),
                  "command": _mod("suite").GRANT_COMMAND,
                  "watch": bool(agora.WATCHER.bound)},
        "version": _version(),
    }


def _version() -> str | None:
    try:
        for line in (_PACKAGE_DIR / "plugin.yaml").read_text(encoding="utf-8").splitlines():
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip().strip('"')
    except OSError:
        pass
    return None


def _root(root: str) -> str:
    """`root` as a house this seat knows (raises CockpitError otherwise): a path named in a request, or by a model's
    transcript card, is never read or acted in unless a session worked there or it lies in a scanned folder."""
    return _mod("cockpit").known_root(root, _house_dirs(_settings()))


@router.get("/overview")
def overview(root: str = Query(...)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.overview(_root(root)))


@router.get("/items")
def items(root: str = Query(...), kind: str = Query(...), all: bool = Query(False)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.items(_root(root), kind, include_all=all))


@router.get("/doc")
def doc(root: str = Query(...), path: str = Query(...)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.document(_root(root), path))


@router.get("/link")
def link(root: str = Query(...), target: str = Query(...)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: {"ok": True, "path": cockpit.resolve_link(_root(root), target)})


@router.get("/constitution")
def constitution(root: str = Query(...)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.constitution(_root(root)))


@router.get("/rhythm")
def rhythm(root: str = Query(...)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.rhythm(_root(root)))


@router.get("/doctor")
def doctor(root: str = Query(...), quick: bool = Query(False)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.doctor(_root(root), quick=quick))


@router.get("/lint")
def lint(root: str = Query(...)) -> dict[str, Any]:
    """The org lint as a read: its findings, which are not a refusal."""
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.lint(_root(root)))


@router.get("/history")
def history(root: str = Query(...), limit: int = Query(40)) -> dict[str, Any]:
    cockpit = _mod("cockpit")
    return _guard(lambda: cockpit.git_info(_root(root), commits=max(1, min(limit, 200))))


@router.post("/act")
def act(body: dict = Body(...)) -> dict[str, Any]:
    """One act of the closed list, as the person at the desktop. A refused act answers 200 with ok false and a plain
    `message`, so the page can show why and keep what was typed; a changed house is announced only when it changed."""
    cockpit, suite = _mod("cockpit"), _mod("suite")
    root, action, params = body.get("root"), body.get("action"), body.get("params") or {}
    if not isinstance(action, str) or action not in cockpit.ACTS:
        raise HTTPException(status_code=400, detail=f"no act named {action!r}")
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="params must be an object")
    house = _guard(lambda: _root(str(root or "")))
    data = _guard(lambda: cockpit.act(house, action, params, operator=True))
    if data.get("ok") is not False and action not in cockpit.READ_ACTS:
        suite.broadcast("house.changed", {"root": house, "act": action, "commit": data.get("commit")})
    return data


@router.post("/houses/forget")
def forget(body: dict = Body(...)) -> dict[str, Any]:
    return {"ok": _mod("cockpit").forget_house(str(body.get("root") or ""))}


# ---- rooms -------------------------------------------------------------------------------------------------------


@router.get("/rooms")
def rooms() -> dict[str, Any]:
    return _mod("agora").rooms()


@router.post("/rooms/view")
def room_view(body: dict = Body(...)) -> dict[str, Any]:
    agora = _mod("agora")
    room = str(body.get("room") or "")
    if room and not agora.ROOM_RE.match(room):
        raise HTTPException(status_code=400, detail=f"{room!r} is not a room alias")
    args = ["--room", room] if room else []
    if body.get("refreshRemote"):
        args.append("--refresh-remote")
    payload = {k: body[k] for k in ("seen", "baselineId", "hasBaseline", "self") if k in body}
    return agora.run_pane("view", args=args, payload=payload)


@router.post("/rooms/post")
def room_post(body: dict = Body(...)) -> dict[str, Any]:
    """A post from the person at the desktop: agora's pane posts it as this seat's human (native and local rooms) or
    through the configured post command, exactly as its Tern pane does."""
    agora, suite = _mod("agora"), _mod("suite")
    room = str(body.get("room") or "")
    text = body.get("text")
    if not room or not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="a post needs a room and text")
    args = ["--room", room]
    for key, flag in (("thread", "--thread"), ("re", "--re")):
        value = body.get(key)
        if value:
            if not agora.ID_RE.match(str(value)):
                raise HTTPException(status_code=400, detail=f"{key} is not a message id")
            args += [flag, str(value)]
    for address in body.get("to") or []:
        if not agora.ADDR_RE.match(str(address)):
            raise HTTPException(status_code=400, detail=f"to {address!r} is not an address")
        args += ["--to", str(address)]
    result = agora.run_pane("post", args=args, payload={"text": text})
    if result.get("ok"):
        suite.broadcast("room.posted", {"room": room})
    return result


@router.post("/rooms/name")
def room_name(body: dict = Body(...)) -> dict[str, Any]:
    """Names this seat's human, which native and local posts from the desktop are signed as."""
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="a name is required")
    return _mod("agora").run_pane("set-name", payload={"name": name.strip()})


def _chat_of(key: str) -> str:
    """The stored session id a route key ends with (`local-…` from `agent:main:local:dm:local-…`), which is how the
    desktop names its chats."""
    return key.rsplit(":", 1)[-1] if ":" in key else key


@router.get("/listens")
def listens() -> dict[str, Any]:
    agora = _mod("agora")
    rows = []
    for item in agora.load_listens():
        row = {k: v for k, v in item.items() if k != "pending"}
        row["chat_id"] = _chat_of(str(item.get("session_key") or ""))
        row["waiting"] = len(item.get("pending") or [])
        rows.append(row)
    return {"ok": True, "listens": rows, "watch": bool(agora.WATCHER.bound),
            "granted": _settings().get("allow_gateway_injection", False)}


@router.post("/listens")
def listen(body: dict = Body(...)) -> dict[str, Any]:
    """Brings a chat into a room, or takes it out. The chat is named by its stored session id."""
    agora, suite, cockpit = _mod("agora"), _mod("suite"), _mod("cockpit")
    named = str(body.get("session_key") or "")
    room = str(body.get("room") or "")
    action = body.get("action") or "start"
    if not named:
        raise HTTPException(status_code=400, detail="name the chat (session_key)")
    # The desktop names a chat by its stored id; Hermes delivers a turn by the chat's route key.
    key = agora.route_key_for(named)
    if action == "stop":
        ended = agora.stop_listen(key, room or None)
        suite.broadcast("room.listens", {"session_key": key})
        return {"ok": True, "stopped": ended}
    if not agora.WATCHER.bound:
        raise HTTPException(status_code=409, detail="the lampstand agent half is not loaded in this backend; enable the plugin and restart Hermes")
    if not _settings().get("allow_gateway_injection", False):
        raise HTTPException(status_code=403, detail=f"room wakes are not granted for this profile: {suite.GRANT_COMMAND}")
    house = str(body.get("house") or "")
    house_bearer = ""
    if house:
        try:
            root = cockpit.checked_root(house)
            house_bearer = _mod("rooms").bearer_from_name(str(cockpit.identity(root).get("name") or "")) or ""
        except Exception:
            house = ""
    try:
        bearer = suite.chat_bearer(house_bearer, str(body.get("name") or ""), key)
        item = agora.start_listen(key, room, wake=str(body.get("wake") or agora.DEFAULT_WAKE),
                                  bearer=bearer, house=house, title=str(body.get("title") or "")[:120])
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    suite.broadcast("room.listens", {"session_key": key, "room": room})
    return {"ok": True, "listen": item}
