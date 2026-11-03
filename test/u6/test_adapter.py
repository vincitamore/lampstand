"""The adapter's callbacks: first-turn orientation, the maintenance gate on pre_verify, and lampstand_delegate."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from hosts.hermes import plugin

from .support import NODE, RecordingContext, TempTestCase, plant, region, write_projections


class Lifecycle:
    """Stands in for ctx.subagent_lifecycle, recording each launch request."""

    def __init__(self) -> None:
        self.requests: list[dict] = []

    def launch(self, request: dict) -> str:
        self.requests.append(request)
        return "handle"

    def wait(self, handle: str) -> None:
        return None

    def result(self, handle: str) -> SimpleNamespace:
        return SimpleNamespace(terminal_state=SimpleNamespace(value="SUCCEEDED"), summary="done", error_message=None)


class AdapterCase(TempTestCase):
    def adapter(self, cwd: Path, surface: str = "cli") -> tuple[RecordingContext, Lifecycle]:
        lifecycle = Lifecycle()
        ctx = RecordingContext(cwd=str(cwd), surface=surface, lifecycle=lifecycle)
        plugin.register(ctx)
        return ctx, lifecycle

    def require_cli(self) -> None:
        if NODE is None:
            self.skipTest("node is not on PATH")


class Registration(AdapterCase):
    def test_registering_marks_the_agent_environment(self) -> None:
        os.environ.pop("LAMPSTAND_AGENT", None)
        self.adapter(self.tmp)
        self.assertEqual(os.environ["LAMPSTAND_AGENT"], "hermes")


class RoomActor(AdapterCase):
    def house_with_rooms(self, rooms: bool) -> Path:
        root = self.make_house()
        toml = (root / "house.toml").read_text(encoding="utf-8")
        (root / "house.toml").write_text(f"{toml}\n[modules]\nrooms = {str(rooms).lower()}\n", encoding="utf-8")
        return root

    def first_turn(self, root: Path) -> None:
        ctx, _ = self.adapter(root)
        with mock.patch("hosts.hermes.node.find_node", return_value=None):
            ctx.hooks["pre_llm_call"](is_first_turn=True, platform="cli", session_id="a")

    def test_a_house_with_rooms_on_names_itself(self) -> None:
        os.environ.pop("AGORA_ACTOR", None)
        self.first_turn(self.house_with_rooms(True))
        self.assertEqual(os.environ["AGORA_ACTOR"], "test-house")

    def test_an_actor_already_set_is_kept(self) -> None:
        os.environ["AGORA_ACTOR"] = "Ada/watch"
        self.first_turn(self.house_with_rooms(True))
        self.assertEqual(os.environ["AGORA_ACTOR"], "Ada/watch")

    def test_rooms_off_sets_nothing(self) -> None:
        os.environ.pop("AGORA_ACTOR", None)
        self.first_turn(self.house_with_rooms(False))
        self.assertNotIn("AGORA_ACTOR", os.environ)


class Orientation(AdapterCase):
    def test_only_the_first_turn_of_a_main_session_is_oriented(self) -> None:
        root = self.make_house()
        ctx, _ = self.adapter(root)
        hook = ctx.hooks["pre_llm_call"]
        self.assertIsNone(hook(is_first_turn=False, platform="cli", session_id="a"))
        self.assertIsNone(hook(is_first_turn=True, platform="subagent", session_id="b"))

    def test_a_dormant_session_is_silent(self) -> None:
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        ctx, _ = self.adapter(elsewhere)
        self.assertIsNone(ctx.hooks["pre_llm_call"](is_first_turn=True, platform="cli", session_id="a"))

    def test_the_first_turn_carries_the_cli_orientation(self) -> None:
        self.require_cli()
        root = self.make_house()
        ctx, _ = self.adapter(root / "tasks")
        context = ctx.hooks["pre_llm_call"](is_first_turn=True, platform="cli", session_id="a")["context"]
        self.assertTrue(context.startswith(f"lampstand house {root}:"), context)
        self.assertNotIn("orientation failed", context)
        self.assertNotIn("Node.js", context)

    def test_a_stale_kernel_in_the_section_is_named(self) -> None:
        root = self.make_house()
        (root / "voice.md").write_text("# Voice\n", encoding="utf-8")
        ctx, _ = self.adapter(root)
        with mock.patch("hosts.hermes.node.find_node", return_value=None):
            context = ctx.hooks["pre_llm_call"](is_first_turn=True, platform="cli", session_id="a")["context"]
        self.assertIn("kernel.md is stale", context)
        self.assertIn("lampstand compile", context)

    def test_missing_node_is_reported_once(self) -> None:
        root = self.make_house()
        ctx, _ = self.adapter(root)
        hook = ctx.hooks["pre_llm_call"]
        with mock.patch("hosts.hermes.node.find_node", return_value=None):
            first = hook(is_first_turn=True, platform="cli", session_id="a")["context"]
            second = hook(is_first_turn=True, platform="cli", session_id="b")["context"]
        self.assertIn("Node.js", first)
        self.assertNotIn("Node.js", second)


class Gate(AdapterCase):
    def setUp(self) -> None:
        super().setUp()
        self.require_cli()

    def gate(self, mode: str) -> tuple[Path, object]:
        root = self.make_house(gate=mode)
        ctx, _ = self.adapter(root)
        return root, ctx.hooks["pre_verify"]

    def test_remind_mode_reminds_once_per_session(self) -> None:
        root, hook = self.gate("remind")
        first = hook(session_id="a", platform="cli", changed_paths=[str(root / "notes.txt")])
        self.assertEqual(first["action"], "continue")
        self.assertIn("task", first["message"])
        self.assertIn("state", first["message"])
        self.assertIsNone(hook(session_id="a", platform="cli", changed_paths=[str(root / "notes.txt")]))
        self.assertIsNotNone(hook(session_id="b", platform="cli", changed_paths=[str(root / "notes.txt")]))

    def test_block_mode_holds_until_the_session_has_recorded_its_work(self) -> None:
        root, hook = self.gate("block")
        for _ in range(2):
            held = hook(session_id="a", platform="cli", changed_paths=["notes.txt"])
            self.assertEqual(held["action"], "continue")
        # Paths accumulate across the session's turns: recording the work later releases the gate.
        recorded = [str(root / "tasks" / "t.md"), str(root / "state" / "current.md")]
        released = hook(session_id="a", platform="cli", changed_paths=recorded)
        self.assertIsNone(released)

    def test_off_mode_and_subagents_owe_nothing(self) -> None:
        root, hook = self.gate("off")
        self.assertIsNone(hook(session_id="a", platform="cli", changed_paths=[str(root / "notes.txt")]))
        _, hook = self.gate("block")
        self.assertIsNone(hook(session_id="a", platform="subagent", changed_paths=[str(root / "notes.txt")]))


class Delegate(AdapterCase):
    def call(self, ctx: RecordingContext, **args: str) -> dict:
        return json.loads(ctx.tools["lampstand_delegate"]["handler"](args, task_id="t"))

    def test_the_launch_carries_w_then_the_role_brief_then_the_callers_context(self) -> None:
        root = self.make_house()
        write_projections(root, worker_reflexes="- check the build before reporting")
        ctx, lifecycle = self.adapter(root)
        result = self.call(ctx, role="builder", goal="Build the parser.", context="Files: core/lib/parse/")
        self.assertEqual(result, {"ok": True, "role": "builder", "state": "SUCCEEDED", "summary": "done"})
        (request,) = lifecycle.requests
        self.assertEqual((request["goal"], request["role"]), ("Build the parser.", "leaf"))
        context = request["context"]
        self.assertTrue(context.startswith("<!-- lampstand:worker:hermes -->\nPurpose: Keep the test honest."))
        self.assertIn("- check the build before reporting", context)
        self.assertIn("You build one unit.", context)
        self.assertNotIn("name: builder", context)
        self.assertTrue(context.endswith("Files: core/lib/parse/"))
        self.assertLess(context.index("check the build"), context.index("You build one unit."))

    def test_a_subagent_whose_folder_loads_the_region_gets_w_without_a_second_k(self) -> None:
        # The subagent works in the house like the main session, so it loads AGENTS.md, whose region carries K.
        root = self.make_house()
        write_projections(root, worker_reflexes="- check the build before reporting")
        plant(root, {"AGENTS.md": region(root / ".house" / "generated" / "kernel.md")})
        self.assertTrue(plugin.house_region_loads(str(root), str(root)))
        ctx, lifecycle = self.adapter(root)
        self.assertTrue(self.call(ctx, role="builder", goal="g")["ok"])
        context = lifecycle.requests[0]["context"]
        self.assertTrue(context.startswith("<!-- lampstand:worker:hermes -->\n## Reflexes"), context[:120])
        self.assertNotIn("Purpose: Keep the test honest.", context)
        self.assertIn("- check the build before reporting", context)
        self.assertIn("You build one unit.", context)

    def test_a_stale_worker_is_still_used_and_named(self) -> None:
        root = self.make_house()
        (root / "voice.md").write_text("# Voice\n", encoding="utf-8")
        ctx, lifecycle = self.adapter(root)
        result = self.call(ctx, role="builder", goal="g")
        self.assertIn("worker.hermes.md is stale", result["notices"][0])
        self.assertIn("<!-- lampstand:worker:hermes -->", lifecycle.requests[0]["context"])

    def test_unknown_roles_and_oversized_context_launch_nothing(self) -> None:
        root = self.make_house()
        ctx, lifecycle = self.adapter(root)
        refused = self.call(ctx, role="../etc", goal="g")
        self.assertFalse(refused["ok"])
        self.assertIn("builder", refused["error"])
        oversized = self.call(ctx, role="builder", goal="g", context="x" * 32_000)
        self.assertFalse(oversized["ok"])
        self.assertIn("32000", oversized["error"])
        self.assertEqual(lifecycle.requests, [])

    def test_the_tool_schema_offers_the_shipped_roles(self) -> None:
        ctx, _ = self.adapter(self.tmp)
        role = ctx.tools["lampstand_delegate"]["schema"]["parameters"]["properties"]["role"]
        self.assertIn("builder", role["enum"])
        self.assertEqual(role["enum"], sorted(role["enum"]))
