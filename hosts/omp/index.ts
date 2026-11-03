// The lampstand adapter for OMP (oh-my-pi). OMP imports this module in-process under Bun and calls the default export
// once for the main session and again for every subagent session it binds, so all per-session state lives inside the
// factory's closure. The factory itself only registers; every file read happens inside a handler.
//
// What is registered, and nothing more:
//   session_start        main only: resolve the house, verify the projection's input hash, queue the orientation
//   before_agent_start   main: the router; subagent: the worker. A projection is added only when its marker is absent,
//                        without the kernel or any router section the prompt already carries (the AGENTS.md region)
//   tool_execution_end   main only: the paths write and edit changed, which the maintenance gate judges
//   session_stop         the maintenance gate (OMP fires it for main sessions only; the guard below holds regardless)
//   /lampstand           status, compile, doctor and adopt, run in this process
// No tool_call, tool_result, tool_approval_requested or tool_approval_resolved handler is registered: any one of them
// switches off the host's speculative tool execution.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { runCli } from "../../core/lib/cli.js";
import { GENERATED_DIR, projectionMarker, readHeader } from "../../core/lib/constitution/compile.js";
import { today } from "../../core/lib/constitution/curate.js";
import { inputHash, readInputs } from "../../core/lib/constitution/house.js";
import { runCompile } from "../../core/lib/constitution/run.js";
import { adoptInteractively } from "../../core/lib/constitution/verbs.js";
import { isLampstandError } from "../../core/lib/errors.js";
import { checkGate } from "../../core/lib/gate.js";
import { splitRouter } from "../../core/lib/init/region.js";
import { normalizeLf } from "../../core/lib/io.js";
import { registry } from "../../core/lib/verbs.js";
import { capLines, orient } from "../../core/lib/orient.js";
import { resolveHouse } from "../../core/lib/root.js";

/**
 * The oldest OMP this adapter runs on: `ctx.agent`, the only way a handler can tell a subagent from the main session,
 * first shipped in 18.3.2. Without it every subagent would be handed the router.
 */
export const OMP_FLOOR = "18.3.2";

/** The verbs `/lampstand` forwards. */
export const FORWARDED = Object.freeze(["status", "compile", "doctor", "adopt"]);

/** Tools whose results name the files they changed (write: `details.resolvedPath`; edit: `details.path` or per file). */
const EDIT_TOOLS = new Set(["write", "edit"]);

type Level = "info" | "warning" | "error";

/** The subset of OMP's extension API this adapter uses, typed here because the package ships no dependency on OMP. */
export interface HostUi {
  notify(message: string, type?: Level): void;
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface HostContext {
  cwd: string;
  hasUI: boolean;
  ui: HostUi;
  agent?: { kind: "main" | "sub" };
}

export interface HostMessage {
  customType: string;
  content: string;
  display: boolean;
}

export interface HostApi {
  on<E, R = unknown>(event: string, handler: (event: E, ctx: HostContext) => R | Promise<R>): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
      handler: (args: string, ctx: HostContext) => Promise<void>;
    },
  ): void;
  sendMessage(message: HostMessage, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean }): void;
  pi?: { VERSION?: string };
}

interface BeforeAgentStartEvent {
  systemPrompt: string[];
  reason?: string;
}

interface ToolExecutionEndEvent {
  toolName: string;
  result: unknown;
  isError: boolean;
}

interface SessionStopResult {
  decision: "block";
  reason: string;
}

/** True when `version` is a release at or above `floor`; an unreadable version is below every floor. */
export function atLeast(version: string | undefined, floor: string): boolean {
  const parse = (text: string | undefined) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const have = parse(version);
  const need = parse(floor);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** One line to the operator: the UI when the session has one, stderr otherwise (print mode). */
function notice(ctx: HostContext, text: string, level: Level): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`${text}\n`);
}

const isSub = (ctx: HostContext) => ctx.agent?.kind === "sub";

/** True when one of the prompt's blocks carries `marker` as a whole line. */
export function carries(prompt: readonly string[], marker: string): boolean {
  return prompt.some((block) => block.split("\n").some((line) => line.trimEnd() === marker));
}

/** A generated projection as written to disk (LF), or null when it has not been compiled. */
function readProjection(root: string, projection: string): string | null {
  const path = join(root, ...GENERATED_DIR.split("/"), `${projection.replace(":", ".")}.md`);
  return existsSync(path) ? normalizeLf(readFileSync(path, "utf8")) : null;
}

/** The manifest's surfaces, or null when it is absent or unreadable (the adapter then cuts only the kernel). */
function readSurfaces(root: string): Record<string, { chars: number }> | null {
  const path = join(root, ...GENERATED_DIR.split("/"), "manifest.json");
  try {
    const surfaces = JSON.parse(readFileSync(path, "utf8"))?.surfaces;
    return surfaces !== null && typeof surfaces === "object" ? surfaces : null;
  } catch {
    return null;
  }
}

/**
 * What to append for one projection: nothing when the prompt already carries its marker; otherwise the projection
 * without what the prompt already carries. K is cut when the kernel's marker is present (K is never loaded twice), by
 * exact bytes from kernel.md, which the compiler guarantees every projection opens with. A router section is left out
 * when its `section:<name>` marker is present, which is how the house's AGENTS.md region marks the sections it holds;
 * the sections are cut by the sizes in `surfaces`, and a router that does not split by them falls back to the K cut.
 */
export function addition(
  prompt: readonly string[],
  text: string,
  kernelText: string | null,
  surfaces: Record<string, { chars: number }> | null = null,
): string | null {
  const [header, marker] = text.split("\n", 2);
  if (marker === undefined || carries(prompt, marker)) return null;
  if (kernelText === null || !carries(prompt, projectionMarker("kernel"))) return text;
  const kernelHead = kernelText.split("\n", 2).join("\n").length + 1;
  const kernel = kernelText.slice(kernelHead).replace(/\n$/, "");
  const head = `${header}\n${marker}\n`;
  if (!text.startsWith(kernel, head.length)) return text;
  const host = /^<!-- lampstand:router:([a-z]+) -->$/.exec(marker)?.[1];
  if (host !== undefined && surfaces !== null) {
    try {
      const kept = splitRouter(text, kernel, surfaces, host).filter(
        (section) => !carries(prompt, projectionMarker(`section:${section.name}`)),
      );
      return kept.length === 0 ? null : `${head}${kept.map((section) => `## ${section.title}\n\n${section.body}`).join("\n\n")}\n`;
    } catch {
      // A router the manifest does not describe (compiled by another version): cut only the kernel.
    }
  }
  const rest = text.slice(head.length + kernel.length).replace(/^\n+/, "");
  return rest === "" ? null : `${head}${rest}`;
}

/** Paths a write or edit result reports as changed; internal URLs (local://, skill://, ...) are not files. */
export function changedPaths(result: unknown): string[] {
  const details = result !== null && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
  if (details === null || typeof details !== "object") return [];
  const out: string[] = [];
  const take = (value: unknown) => {
    if (typeof value === "string" && value !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) out.push(value);
  };
  const record = details as Record<string, unknown>;
  take(record.resolvedPath);
  take(record.path);
  take(record.sourcePath);
  if (Array.isArray(record.perFileResults)) {
    for (const file of record.perFileResults) {
      if (file !== null && typeof file === "object") {
        take((file as Record<string, unknown>).path);
        take((file as Record<string, unknown>).sourcePath);
      }
    }
  }
  return out;
}

/** Splits command arguments on whitespace, keeping single- or double-quoted runs whole. */
function words(args: string): string[] {
  const out: string[] = [];
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

const REGISTRY = registry(FORWARDED);

export default function lampstand(pi: HostApi): void {
  const version = pi.pi?.VERSION;
  if (!atLeast(version, OMP_FLOOR)) {
    let told = false;
    pi.on("session_start", (_event: unknown, ctx) => {
      if (told) return;
      told = true;
      notice(ctx, `lampstand is off: it needs OMP ${OMP_FLOOR} or later, and this OMP is ${version ?? "of unknown version"}`, "warning");
    });
    return;
  }

  // Per-session state. A subagent binding gets its own closure, so none of this crosses sessions.
  const told = new Set<string>();
  const edited = new Set<string>();
  let reminded = false;
  // The commit and time the session began at, so the gate also sees work recorded through verbs, the shell or
  // subagents, which the edit-tool events never show.
  let started: { since: string; sinceMs: number } | null = null;
  const checked = new Set<string>();

  const once = (ctx: HostContext, key: string, text: string, level: Level) => {
    if (told.has(key)) return;
    told.add(key);
    notice(ctx, text, level);
  };

  /** The house for this session's cwd, or null (dormant). Resolution errors are told once and leave it dormant. */
  const locate = (ctx: HostContext): string | null => {
    try {
      return resolveHouse({ cwd: ctx.cwd, env: process.env }).root;
    } catch (error) {
      if (!isLampstandError(error)) throw error;
      once(ctx, `resolve:${error.code}`, `lampstand: ${error.code}: ${error.message}`, "error");
      return null;
    }
  };

  const send = (content: string) => pi.sendMessage({ customType: "lampstand", content, display: true });

  /**
   * A projection to load, checked once per session against the house's current input hash. A stale projection is
   * still loaded, with a one-line notice; a missing one loads nothing.
   */
  const load = (ctx: HostContext, root: string, projection: string): string | null => {
    const text = readProjection(root, projection);
    if (text === null) {
      once(ctx, `missing:${root}`, `lampstand: ${root} has no compiled ${projection} projection; run lampstand compile`, "warning");
      return null;
    }
    if (text.split("\n", 2)[1] !== projectionMarker(projection)) {
      once(ctx, `marker:${root}:${projection}`, `lampstand: ${GENERATED_DIR}/${projection.replace(":", ".")}.md is not a lampstand projection; run lampstand compile`, "error");
      return null;
    }
    const key = `${root}:${projection}`;
    if (!checked.has(key)) {
      checked.add(key);
      let current: string | null = null;
      try {
        current = inputHash(readInputs(root));
      } catch (error) {
        if (!isLampstandError(error)) throw error;
        once(ctx, `inputs:${root}`, `lampstand: cannot hash the house's inputs (${error.message}); loading the projection unverified`, "warning");
      }
      if (current !== null && readHeader(text)?.inputHash !== current) {
        once(ctx, `stale:${root}`, `lampstand: the projections in ${GENERATED_DIR} are stale (input hash mismatch); loaded anyway; run lampstand compile`, "warning");
      }
    }
    return text;
  };

  pi.on("session_start", (_event: unknown, ctx) => {
    if (isSub(ctx)) return;
    told.clear();
    edited.clear();
    checked.clear();
    reminded = false;
    started = null;
    const root = locate(ctx);
    if (root === null) {
      once(ctx, "dormant", `lampstand: no house here (no house.toml at or above ${ctx.cwd}); nothing loaded this session`, "info");
      return;
    }
    const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
    started = { since: head.status === 0 ? head.stdout.trim() : "", sinceMs: Date.now() };
    // Verifies the router's input hash now, so a stale or missing projection is told before the first prompt.
    load(ctx, root, "router:omp");
    const found = orient(root, { env: process.env });
    const { text } = capLines([`lampstand orientation for the house at ${root}:`, ...found.lines], found.cap);
    pi.sendMessage({ customType: "lampstand-orientation", content: text, display: false }, { deliverAs: "nextTurn" });
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx): { systemPrompt: string[] } | undefined => {
    // A revived subagent's preparation result is discarded by the host.
    if (event.reason === "revive") return undefined;
    const root = locate(ctx);
    if (root === null) return undefined;
    const text = load(ctx, root, isSub(ctx) ? "worker:omp" : "router:omp");
    if (text === null) return undefined;
    const added = addition(event.systemPrompt, text, readProjection(root, "kernel"), readSurfaces(root));
    return added === null ? undefined : { systemPrompt: [...event.systemPrompt, added] };
  });

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx) => {
    if (isSub(ctx) || event.isError || !EDIT_TOOLS.has(event.toolName)) return;
    for (const path of changedPaths(event.result)) edited.add(isAbsolute(path) ? path : resolve(ctx.cwd, path));
  });

  pi.on("session_stop", (_event: unknown, ctx): SessionStopResult | undefined => {
    if (isSub(ctx)) return undefined;
    const root = locate(ctx);
    if (root === null) return undefined;
    let gate;
    try {
      gate = checkGate(root, [...edited], started ?? undefined);
    } catch (error) {
      if (!isLampstandError(error)) throw error;
      once(ctx, `gate:${error.code}`, `lampstand: the maintenance gate cannot run: ${error.code}: ${error.message}`, "error");
      return undefined;
    }
    if (gate.block !== null) return { decision: "block", reason: `lampstand: ${gate.block}` };
    if (gate.owed.length === 0 || reminded) return undefined;
    reminded = true;
    const owed = gate.owed.map((item) => `${item.id}: ${item.owed}`).join("; ");
    notice(ctx, `lampstand: this session owes the house: ${gate.owed.map((item) => item.id).join(", ")}`, "info");
    pi.sendMessage(
      { customType: "lampstand-gate", content: `lampstand reminder: this session changed files and owes the house: ${owed}.`, display: true },
      { deliverAs: "nextTurn" },
    );
    return undefined;
  });

  /** `adopt` asked item by item through the host's UI; without a UI every item is shown and left for later. */
  const adoptHere = async (ctx: HostContext, workspace: boolean) => {
    const root = resolveHouse({ cwd: ctx.cwd, env: process.env, workspace }).root;
    if (root === null) {
      send(`lampstand: E_NO_HOUSE: no house resolved from ${ctx.cwd}`);
      return;
    }
    const acts = await adoptInteractively(
      root,
      {
        show: send,
        ask: async (question) => (ctx.hasUI ? ((await ctx.ui.select(question.trim(), ["later", "adopt", "edit", "strike"])) ?? "") : ""),
        // The conversation's edit is synchronous; an editor cannot be opened over the host's terminal from here.
        edit: () => false,
      },
      today(),
    );
    const lines = acts.length === 0 ? ["no proposed items"] : acts.map((act) => `${act.act} ${act.id}${act.refused ? `: ${act.refused}` : ""}`);
    if (acts.some((act) => act.act === "adopted")) {
      const run = runCompile(root);
      lines.push(run.errors.length === 0 ? "compiled .house/generated/" : "compile refused: projections not updated");
      lines.push(...run.findings.map((finding) => `${finding.level} [${finding.rule}] ${finding.message}`));
    }
    send(lines.join("\n"));
  };

  pi.registerCommand("lampstand", {
    description: `lampstand ${FORWARDED.join(" | ")}`,
    getArgumentCompletions: (prefix) => {
      const hits = FORWARDED.filter((verb) => verb.startsWith(prefix.trim()));
      return hits.length === 0 ? null : hits.map((verb) => ({ value: verb, label: verb }));
    },
    handler: async (args, ctx) => {
      const argv = words(args);
      if (!FORWARDED.includes(argv[0] ?? "")) {
        send(`usage: /lampstand ${FORWARDED.join("|")} [args] [--json]`);
        return;
      }
      try {
        // The CLI's adopt prompts on the process's own stdin when it is a TTY, which here is the host's terminal.
        if (argv[0] === "adopt" && argv.slice(1).every((arg) => arg === "--no-workspace")) {
          await adoptHere(ctx, !argv.includes("--no-workspace"));
          return;
        }
        let out = "";
        const sink = { write: (text: string) => (out += text) };
        const code = await runCli(REGISTRY, argv, { stdout: sink, stderr: sink, env: process.env, cwd: ctx.cwd });
        send(`${out.trimEnd()}${code === 0 ? "" : `\n(exit ${code})`}`);
      } catch (error) {
        if (!isLampstandError(error)) throw error;
        send(`lampstand: ${error.code}: ${error.message}`);
      }
    },
  });
}
