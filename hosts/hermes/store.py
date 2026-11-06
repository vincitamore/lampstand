"""lampstand's own small files under the Hermes home, written so several processes can share them.

The gateway, a classic `hermes chat` process and the desktop backend may all read and write the same listens and house
register. A process-local lock is not enough for that, and on Windows `os.replace` fails while another process has the
target open. Every change here takes a lock file next to the target, writes a temporary file whose name no other
writer uses, and retries the replace briefly. A read that cannot get the file raises instead of answering with
nothing, so a caller that rewrites the file never saves an empty list over every entry.
"""

from __future__ import annotations

import contextlib
import importlib
import json
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

LOCK_WAIT_SECONDS = 5.0
# A lock file older than this is left over from a process that died holding it.
LOCK_STALE_SECONDS = 30.0
_thread_lock = threading.RLock()


def hermes_module(name: str) -> Any:
    """A Hermes module, looked up when it is used and never at import: the adapter loads (and is tested) without
    Hermes on the path. None when this process has no such module."""
    try:
        return importlib.import_module(name)
    except Exception:
        return None


def hermes_home() -> Path:
    """The Hermes home of the profile this call runs for: Hermes's own resolver when it is importable (a multiplexed
    gateway scopes it per profile), else HERMES_HOME, else the platform default Hermes uses."""
    constants = hermes_module("hermes_constants")
    if constants is not None:
        try:
            return Path(constants.get_hermes_home())
        except Exception:
            pass
    value = os.environ.get("HERMES_HOME", "").strip()
    if value:
        return Path(os.path.expanduser(value))
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "hermes"
    return Path.home() / ".hermes"


def state_dir() -> Path:
    """lampstand's own folder under the Hermes home: listens, the house register, the room pane's data."""
    path = hermes_home() / "lampstand"
    path.mkdir(parents=True, exist_ok=True)
    return path


class StoreBusy(OSError):
    """The file stayed locked or unreadable for longer than a person would wait."""


@contextlib.contextmanager
def locked(path: Path) -> Iterator[None]:
    """Holds `<path>.lock` (and this process's lock) for the block."""
    lock = path.with_name(path.name + ".lock")
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    with _thread_lock:
        while True:
            try:
                handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(handle, str(os.getpid()).encode())
                os.close(handle)
                break
            except FileExistsError:
                try:
                    if time.time() - lock.stat().st_mtime > LOCK_STALE_SECONDS:
                        lock.unlink()
                        continue
                except OSError:
                    pass
            except PermissionError:
                pass
            if time.monotonic() > deadline:
                raise StoreBusy(f"{lock} stayed locked for {LOCK_WAIT_SECONDS:.0f}s")
            time.sleep(0.05)
        try:
            yield
        finally:
            with contextlib.suppress(OSError):
                lock.unlink()


def read_json(path: Path, default: Any) -> Any:
    """The file's JSON, or `default` when it does not exist. Raises StoreBusy when it exists and cannot be read."""
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return default
        except (PermissionError, ValueError) as error:
            # Another process is replacing it (Windows) or a writer from before this module left it torn.
            if time.monotonic() > deadline:
                if isinstance(error, ValueError):
                    return default
                raise StoreBusy(f"{path} could not be read: {error}") from error
            time.sleep(0.05)


def write_json(path: Path, value: Any) -> None:
    """Replaces the file's content in one step. Call it inside `locked(path)`."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(json.dumps(value, indent=1), encoding="utf-8")
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if time.monotonic() > deadline:
                with contextlib.suppress(OSError):
                    temporary.unlink()
                raise
            time.sleep(0.05)


def update_json(path: Path, default: Any, change: Callable[[Any], Any]) -> Any:
    """Reads the file, lets `change` mutate its value in place, and writes it back, all under the lock. Returns what
    `change` returned."""
    with locked(path):
        value = read_json(path, default)
        result = change(value)
        write_json(path, value)
        return result
