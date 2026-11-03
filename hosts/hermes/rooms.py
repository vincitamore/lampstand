"""Names a house with the rooms module on in AGORA_ACTOR for its own sessions (see core/lib/rooms/actor.js).

agora signs a room post with --as, else AGORA_ACTOR, else the session's record, else the seat-wide actor.name. A house
session that fell through to the last would sign as whoever the seat usually is, so the house names itself, unless the
environment already carries an actor. Only the agent's own process environment is changed; agora's config never is.
"""

from __future__ import annotations

import os
import re
import tomllib
import unicodedata

from .root import read_text

SEGMENT_MAX = 32


def bearer_from_name(name: str) -> str | None:
    """The house name as an agora bearer: letters, digits, . _ -, starting with a letter or digit, at most 32 characters."""
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(ch for ch in decomposed if not "\u0300" <= ch <= "\u036f")
    cleaned = re.sub(r"^[^A-Za-z0-9]+", "", re.sub(r"[^A-Za-z0-9._-]+", "-", stripped))
    cut = re.sub(r"[-._]+$", "", cleaned[:SEGMENT_MAX])
    return cut or None


# The value this module last put in AGORA_ACTOR: a process serving several houses in turn may replace its own earlier
# value, never an actor the operator or the launcher set.
_ours: str | None = None


def mark_room_actor(root: str) -> str | None:
    """Sets AGORA_ACTOR to the house's name when `[modules] rooms = true` and nobody else's is set. A value set here for
    another house is replaced, or removed when this house has rooms off. Returns the name set."""
    global _ours
    present = bool(os.environ.get("AGORA_ACTOR", "").strip())
    if present and os.environ["AGORA_ACTOR"] != _ours:
        return None
    name = _house_bearer(root)
    if name is None:
        if present:
            del os.environ["AGORA_ACTOR"]
        _ours = None
        return None
    os.environ["AGORA_ACTOR"] = name
    _ours = name
    return name


def _house_bearer(root: str) -> str | None:
    try:
        data = tomllib.loads(read_text(os.path.join(root, "house.toml")))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None
    modules = data.get("modules")
    house = data.get("house")
    if not isinstance(modules, dict) or modules.get("rooms") is not True or not isinstance(house, dict):
        return None
    return bearer_from_name(str(house.get("name", "")))
