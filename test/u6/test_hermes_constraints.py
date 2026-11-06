"""Hermes-side constraints (DESIGN §3, §10): the adapter imports only the standard library, and register() finishes
within a second without starting a process, opening a socket or reading a file."""

from __future__ import annotations

import ast
import importlib
import socket
import subprocess
import sys
import time
import unittest
from unittest import mock

from .support import REPO, RecordingContext

ADAPTER = REPO / "hosts" / "hermes"


def imported_modules(path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), str(path))):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


class StandardLibraryOnly(unittest.TestCase):
    def test_every_absolute_import_is_standard_library(self) -> None:
        files = sorted(ADAPTER.glob("*.py")) + [REPO / "__init__.py"]
        self.assertGreater(len(files), 4)
        for path in files:
            with self.subTest(path.name):
                outside = imported_modules(path) - set(sys.stdlib_module_names) - {"__future__"}
                self.assertEqual(outside, set())


def _forbidden(*args, **kwargs):
    raise AssertionError("register() must not start processes, open sockets or read files")


class RegisterIsCheap(unittest.TestCase):
    def fresh_plugin(self):
        """The plugin imported anew, as a Hermes process imports it; the earlier modules return after the test so
        other tests keep patching the modules their adapters use."""
        saved = {n: m for n, m in sys.modules.items() if n == "hosts.hermes" or n.startswith("hosts.hermes.")}
        for name in saved:
            del sys.modules[name]
        self.addCleanup(sys.modules.update, saved)
        return importlib.import_module("hosts.hermes.plugin")

    def test_import_and_register_take_under_a_second(self) -> None:
        start = time.perf_counter()
        self.fresh_plugin().register(RecordingContext())
        self.assertLess(time.perf_counter() - start, 1.0)

    def test_register_starts_no_process_and_opens_no_socket_or_file(self) -> None:
        plugin = self.fresh_plugin()
        ctx = RecordingContext()
        with (
            mock.patch.object(subprocess, "Popen", _forbidden),
            mock.patch.object(socket, "socket", _forbidden),
            mock.patch("os.system", _forbidden),
            mock.patch("builtins.open", _forbidden),
        ):
            plugin.register(ctx)
        self.assertEqual(set(ctx.hooks), {"pre_llm_call", "post_llm_call", "pre_verify", "post_compaction", "post_gateway_admission"})
        self.assertEqual(set(ctx.tools), {"lampstand_delegate", *plugin.TOOL_NAMES})
        self.assertEqual(set(ctx.commands), {"lampstand"})
        self.assertEqual(set(ctx.sections), {"lampstand-kernel"})

    def test_register_starts_no_thread(self) -> None:
        import threading

        plugin = self.fresh_plugin()
        before = {t.name for t in threading.enumerate()}
        plugin.register(RecordingContext())
        self.assertNotIn("lampstand-rooms", {t.name for t in threading.enumerate()} - before)
