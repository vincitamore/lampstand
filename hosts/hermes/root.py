"""House resolution, the Python twin of core/lib/root.js; both pass schema/conformance/root/.

The order is fixed: HOUSE_ROOT (no fallback when it is wrong), then a walk up from the working directory that passes
through git roots, then default_house from per-user config only on a surface with no workspace, then dormant.
"""

from __future__ import annotations

import os
import sys
import tomllib
from collections.abc import Mapping
from typing import NamedTuple


class LampstandError(Exception):
    """A failure carrying one of the stable codes defined in core/lib/errors.js."""

    def __init__(self, code: str, message: str, path: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path

    def __str__(self) -> str:
        return f"{self.code}: {self.message}" + (f" ({self.path})" if self.path else "")


class Resolution(NamedTuple):
    rule: str  # HOUSE_ROOT | walk-up | default_house | dormant
    root: str | None


def read_text(path: str) -> str:
    """A UTF-8 file without its BOM and with LF line endings, as core/lib/io.js readText reads it."""
    with open(path, "rb") as handle:
        text = handle.read().decode("utf-8")
    return text.removeprefix("\ufeff").replace("\r\n", "\n")


def has_house_toml(directory: str) -> bool:
    """True when `directory` holds a regular file named house.toml (a directory of that name is not a marker)."""
    try:
        return os.path.isfile(os.path.join(directory, "house.toml"))
    except (OSError, ValueError):
        return False


def _home(env: Mapping[str, str]) -> str:
    # Node's os.homedir() reads USERPROFILE on Windows and HOME elsewhere before asking the OS.
    return env.get("USERPROFILE" if sys.platform == "win32" else "HOME") or os.path.expanduser("~")


def config_root(env: Mapping[str, str]) -> str:
    """LAMPSTAND_CONFIG_ROOT when set, else the platform's per-user config directory (core/lib/config.js)."""
    override = env.get("LAMPSTAND_CONFIG_ROOT")
    if override:
        if not os.path.isabs(override):
            raise LampstandError("E_ENV_INVALID", f"LAMPSTAND_CONFIG_ROOT must be an absolute path, got {override!r}")
        return override
    if sys.platform == "win32":
        return env.get("APPDATA") or os.path.join(_home(env), "AppData", "Roaming")
    if sys.platform == "darwin":
        return os.path.join(_home(env), "Library", "Application Support")
    xdg = env.get("XDG_CONFIG_HOME")
    return xdg if xdg and os.path.isabs(xdg) else os.path.join(_home(env), ".config")


def user_config_path(env: Mapping[str, str]) -> str:
    return os.path.join(config_root(env), "lampstand", "config.toml")


def _schema_error(path: str, key: str, expected: str) -> LampstandError:
    return LampstandError("E_SCHEMA", f"{key} must be {expected}", path)


def load_user_config(env: Mapping[str, str]) -> dict:
    """The per-user config, or {} when the file does not exist; held to USER_CONFIG_SCHEMA in core/lib/config.js."""
    path = user_config_path(env)
    if not os.path.exists(path):
        return {}
    try:
        data = tomllib.loads(read_text(path))
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as error:
        raise LampstandError("E_PARSE_TOML", str(error), path) from error
    except OSError as error:
        raise LampstandError("E_IO", f"cannot read: {error}", path) from error
    for key, value in data.items():
        if key == "default_house":
            if not isinstance(value, str) or value == "":
                raise _schema_error(path, key, "a non-empty string")
        elif key == "houses":
            if not isinstance(value, dict):
                raise _schema_error(path, key, "a table")
            for house_id, entry in value.items():
                if not isinstance(entry, dict):
                    raise _schema_error(path, f"houses.{house_id}", "a table")
                for field, setting in entry.items():
                    if field != "state_dir":
                        raise LampstandError("E_SCHEMA", f"houses.{house_id}.{field} is not a known key", path)
                    if not isinstance(setting, str) or setting == "":
                        raise _schema_error(path, f"houses.{house_id}.state_dir", "a non-empty string")
        else:
            raise LampstandError("E_SCHEMA", f"{key} is not a known key", path)
    return data


def _canonical(directory: str) -> str:
    # One house reached through a symlink or a differently-cased path keeps one identity.
    return os.path.realpath(directory)


def resolve_house(cwd: str | None = None, env: Mapping[str, str] | None = None, workspace: bool = True) -> Resolution:
    """Resolves the house for a session at `cwd`. `workspace=False` declares a surface with no workspace (messaging,
    scheduled ticks), the only case in which default_house is consulted. Raises LampstandError."""
    env = os.environ if env is None else env
    start = os.path.abspath(cwd if cwd else os.getcwd())

    # An empty HOUSE_ROOT counts as unset: shells and service managers export empty variables routinely.
    named = env.get("HOUSE_ROOT")
    if named:
        directory = os.path.normpath(os.path.join(start, named))
        if not has_house_toml(directory):
            raise LampstandError(
                "E_HOUSE_ROOT_INVALID", f"HOUSE_ROOT={named} does not hold house.toml (resolved to {directory})"
            )
        return Resolution("HOUSE_ROOT", _canonical(directory))

    directory = start
    while True:
        if has_house_toml(directory):
            return Resolution("walk-up", _canonical(directory))
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent

    if not workspace:
        fallback = load_user_config(env).get("default_house")
        if fallback is not None:
            path = user_config_path(env)
            if not os.path.isabs(fallback):
                raise LampstandError(
                    "E_DEFAULT_HOUSE_INVALID", f"default_house must be an absolute path, got {fallback!r}", path
                )
            if not has_house_toml(fallback):
                message = f"default_house {fallback} does not hold house.toml"
                raise LampstandError("E_DEFAULT_HOUSE_INVALID", message, path)
            return Resolution("default_house", _canonical(fallback))

    return Resolution("dormant", None)
