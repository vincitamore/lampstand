# lampstand: design

lampstand is one package that installs as a plugin into two agent hosts, OMP (oh-my-pi) and Hermes Agent. It plants a
**house**: a git repository the user owns, holding the principles and rules their agent works under, its tasks,
decisions and knowledge as plain files, and the machinery that keeps those files true. The plugin's code is
replaceable; the house is never overwritten by it.

This file is the contract builders work from. Where it and a unit brief disagree, ask; do not choose.

## 1. Repository layout

```
lampstand/                       # default branch = release tree (one built commit per release); `dev` = source
├── package.json                 # "omp": {"extensions": ["./hosts/omp/index.ts"]}; "type": "module";
│                                #   "bin": {"lampstand": "./core/bin/lampstand.js"}; "engines": {"node": ">=22.13"};
│                                #   NO "dependencies" (pinned by a test); devDependencies only
├── plugin.yaml                  # Hermes manifest: manifest_version 2; kind: standalone; requires_hermes;
│                                #   provides_tools / provides_hooks; NO capabilities, requires_env, python_dependencies
├── __init__.py                  # <= 20 lines: from .hosts.hermes.plugin import register
├── README.md  LICENSE  CHANGELOG.md  SECURITY.md  SETUP.md  CONTRIBUTING.md
├── skills/<name>/SKILL.md       # strict Agent Skills frontmatter; loaded by both hosts
├── agents/<name>.md             # task agents (OMP); delegated profiles (Hermes)
├── rules/  commands/            # OMP only
├── core/
│   ├── bin/lampstand.js         # CLI entry (#!/usr/bin/env node)
│   ├── lib/{root,config,frontmatter,cli,errors,io,orient,gate}.js
│   ├── lib/{state,constitution,org,governance,scheduler,doctor,init,seat,rooms}/
│   └── lib/parse/               # our own strict-subset parsers: TOML (house.toml) and frontmatter YAML
├── hosts/
│   ├── __init__.py
│   ├── omp/index.ts             # runs in-process under OMP; self-gates on the host version
│   └── hermes/*.py              # Python standard library only
├── schema/                      # JSON schemas, runtime.sql.txt, conformance vectors read by both JS and Python
├── templates/                   # what `lampstand init` plants
├── packs/                       # principle and charter packs, items marked `proposed` until adopted
├── docs/
└── .github/workflows/
    (dev only) dev/  test/       # gates, tooling, tests. Never named tools/ or hooks/ at the root
```

- **No root `plugin.json`, `tools/`, `hooks/`, `mcp.json`, `pyproject.toml`, `plugin.js` or `desktop/`.** OMP executes
  root `tools/`, `hooks/` and `mcp.json` as conventions and strict-validates every skill when a root `plugin.json`
  exists; Hermes reads a root `pyproject.toml` as dependencies and a root `plugin.js` as its desktop half.
- **Shipped code is `.js`, `.ts` and `.py` only.** Node refuses type stripping under `node_modules`; Bun runs the OMP
  adapter in-process; Hermes is Python. The Hermes install scanner does not read `.mjs`, `.cjs` or `.tsx`, so those
  extensions are not used, and everything shipped is scanned.
- **Two branches.** The default branch moves fast-forward only, one commit per release (Hermes updates with
  `git pull --ff-only`). Work lands on `dev`.

## 2. The house

```
<house>/                         # the user's git repo; planted once by `lampstand init`; never overwritten
├── house.toml                   # marker and manifest
├── AGENTS.md                    # the user's manual; one generated region between <!-- house:begin --> and <!-- house:end -->
├── principles/  charter/  reflexes/  voice.md  curation.md
├── proposals/{principles,reflexes,provisions,updates}/   # never loaded; adopting moves the file out
├── state/current.md
├── tasks/  inbox/{captures,decisions,investigations,ideas}/  knowledge/  reminders/
├── projects/README.md           # what the house builds, one folder per project; the README keeps the folder in a clone
├── forge/  rooms/               # created only by the modules that use them
├── .house/generated/{kernel,router,worker,watchdog}.md, manifest.json   # committed; header carries an input hash
├── .house/planted.json          # what init planted, with hashes (the upgrade comparator)
└── .gitattributes               # *.md *.toml *.json text eol=lf
```

Outside the house, per machine: `<state root>/lampstand/<house-id>-<sha8(realpath root)>/house.db` (with WAL, backups,
logs), where the state root is `%LOCALAPPDATA%`, `~/Library/Application Support` or `$XDG_STATE_HOME` (fallback
`~/.local/state`); per-user config `<config root>/lampstand/config.toml` (`default_house`, per-house `state_dir`
override); the seat ledger `seat.json` beside it.

```toml
[house]      schema = 1
             id = "<uuid>"
             name = "my-house"
[operator]   name = "ana"
             co_owners = []
[purpose]    text = "<= 600 chars: who the work is for"
[charter]    mode = "rules"            # none | rules | agreement
[budget]     profile = "standard"      # lean | standard | large
[modules]    scheduler = false
             rooms = false
             residents = false
             watchdog = false
             orchestration = true
[gate]       mode = "remind"           # off | remind | block
[plugin]     min = "0.1.0"             # an older plugin refuses this house loudly
[packs]      principles = "1"
```

### House resolution (one implementation: `core/lib/root.js`; a Python twin passes the same vectors)

1. `HOUSE_ROOT`, which must contain `house.toml`; otherwise error `E_HOUSE_ROOT_INVALID`, with no fallback.
2. Otherwise walk up from the cwd, passing through git roots, so a nested independent repo still finds its house.
3. Otherwise, only on surfaces with no workspace (messaging, scheduled ticks), `default_house` from per-user config.
4. Otherwise the plugin is dormant: nothing is injected; a one-line hint appears once per session.

### Write map

The plugin writes inside the house only through its verbs, the compiler (derived files) and init (missing files
only). Outside the house it writes only to its own install paths, the per-machine state dir, per-user config and,
with consent per item, a git hook and one OS scheduler entry per house. Each consented outside write is recorded
with its before-value in the seat ledger, which `lampstand seat reset` reverses. It never patches a host, never writes
another plugin's files, never sets a theme or a global setting.

## 3. Runtime

- **One core, ESM `.js` with `// @ts-check` JSDoc**, checked by `tsc --noEmit` in CI. It runs unchanged from a git
  clone, from `node_modules` and from a Hermes plugin directory, on Node >= 22.13 or Bun, with no build step and no
  install-time dependencies.
- **OMP** imports the core in-process. **Hermes** keeps hot paths in Python file reads and spawns
  `node core/bin/lampstand.js` only at bounded points (first turn, a tool call, a command).
- **Python does exactly two things:** it resolves the house, and it reads a generated projection after verifying its
  input hash (sha256 over LF-normalized inputs). It never parses YAML and never writes `house.db`.
- **SQLite:** `bun:sqlite` or `node:sqlite`, picked at runtime. The JS core is the only writer.

## 4. Storage

Authored content (principles, charter, reflexes, tasks, decisions, knowledge, skills) is files in the house's git:
every host loader reads files, git merges across machines, and a person can read the folder. Machine state (presence,
job runs and their outcomes, events and threads, budgets, a rebuildable index) lives in the per-machine `house.db`.
Nothing authored is ever stored only in the database; the database can be deleted and rebuilt.

## 5. CLI contract (all verbs)

- `lampstand <verb> [args] [--json]`. With `--json`, stdout is one JSON object whose first key is `ok`.
- Exit codes: 0 clean, 1 actionable finding, 2 could not run (infrastructure), 64 usage, 70 internal.
- Errors carry a stable code (`E_...`) defined once in `core/lib/errors.js`; docs list every code.

## 6. Conventions

- No runtime dependencies and no vendored code. The TOML and frontmatter YAML parsers are our own strict subsets:
  anything outside the subset is refused with a named error and the file's path, never guessed at.
- Comments carry only the standalone technical why. No dates, no workflow markers, no references to anything outside
  this repository.
- Tests run with `node --test "test/**/*.test.js"` (JS; a directory argument is not searched) and `python -m unittest` (Python); one test directory per unit under `test/`.
- Line endings LF everywhere (`.gitattributes`).

## 7. The constitution

The normative text an agent works under, in seven layers. Every layer is plain files in the house; one compiler turns
them into the projections each host loads.

| Layer | Files | Holds | Who changes it |
|---|---|---|---|
| L0 Registry | `house.toml [surfaces]` | which surfaces exist, the role of each, how it loads, its cap; at most five load unconditionally | the operator |
| L1 Purpose | `house.toml [purpose]`, optional `purpose.md` | who the work is for (`text` <= 600 chars) and an optional long form | the operator |
| L2 Principles | `principles/*.md` | lenses: each has a name, a thesis, facets and a failure mode | the operator adopts; the agent may propose |
| L3 Charter | `charter/core.md`, `charter/provisions/*.md`, `charter/record.md` | how rules are made (`none`, `rules`, `agreement`), the provisions in force, the record of every enactment | the operator enacts; the agent drafts |
| L4 Reflexes | `reflexes/INDEX.md`, `reflexes/<slug>.md` | learned working habits, each scoped `behavioral`, `architectural` or `tool:<host>` | the agent, under `curation.md` |
| L5 Voice | `voice.md` | collaboration manners and per-channel norms | the agent, from observation only |
| L6 State | `state/current.md` | standing reality now (pulled, not pushed) | the agent |

### Principle files

A principle file holds one or more principles. Each principle is a level-3 heading `### <mark> : <Name>` (the mark may
be a symbol or a word), then an italic thesis paragraph, then a bullet list of facets (`- **<facet>**: <text>`), then
a paragraph beginning `*Vice:*` or `*Failure mode:*` (both spellings are read; packs keep their own words). Text
before the first principle heading is the file's preface. Frontmatter carries `origin` (`pack:<name>@<version>` or
`own`), `adopted` (date) and `adopted-hash` (the content hash of the body when adopted; an upgrade compares against it).

### The lattice pack

`packs/lattice/LATTICE.md` is shipped whole and verbatim, under CC0 (`packs/LICENSE`). `lampstand init` asks one
question about it: plant the lattice (default) or start with no principles. Planting copies it to
`principles/lattice.md` as the user's own adopted copy; from then on it is theirs to edit or strike. Upgrades to the
pack never touch that copy: an unedited copy gets `proposals/updates/lattice.md`, an edited one a note that upstream
changed. The pack declares the `large` budget profile it needs (§7 budgets). This is the only file in the repository
whose text may carry symbol marks and em dashes; every gate that bars them exempts this one path by name, and no gate
or tool ever rewrites its text.

### The compiler

`core/lib/constitution/` reads L0 to L6 and writes four projections to `.house/generated/`, each with a header line
`<!-- GENERATED by lampstand from <inputs>; input-hash <sha256>; do not edit -->`:

- **K, the kernel**: purpose, then one line per adopted principle (mark, name, thesis, failure mode), then the
  ask-first lines. Hard cap 4,000 chars measured after the Hermes section formatting; target 3,500.
- **R, the router** (main sessions): K, then principle detail, charter core, the reflex index for this host, voice.
- **W, the worker** (subagents): K, then the reflexes scoped to this host and kind, at most 4,000 chars beyond K.
- **G, the watchdog**: K, then each principle's failure mode and the ask-first lines.

K comes first in every projection, byte-identical across them. Projections are committed; `lampstand check` and CI
regenerate and byte-compare; every loader verifies the input hash at load time and prints a one-line notice when a
projection is stale. Invariants, each with a test: single source; identical kernel bytes; marker-idempotent (a host
that already carries a projection's marker does not add it twice); budgeted; role-scoped (R contains K, W contains K);
host-scoped reflexes; fail loud; provenance line present.

### Budgets (characters; tokens reported beside them, never the gate)

| Surface | standard | large | lean |
|---|---:|---:|---:|
| Kernel | 4,000 hard | 4,000 hard | 2,000 target |
| Principle detail | 12,000 | 36,000 | 4,000 |
| Charter core | 6,000 | 8,000 | 2,000 |
| Reflex index | 8,000 | 10,000 | 2,000 |
| Voice | 3,000 | 3,000 | 1,000 |
| Dynamic orientation | 2,000 | 2,000 | 1,000 |

Totals are derived, never declared. The ratchet: a surface over its cap and larger than at the previous commit is
refused; shrinking always passes. In `rules` and `agreement` mode a cap rises only in a commit carrying a
`Ruled-by: <operator>` trailer, and a commit that both raises a cap and grows the surface it caps is refused.

### Plant, Adopt, Propose

- **Plant** (`lampstand init`): six questions, each explained before it is asked: where; the house's name; who has
  care of it; the purpose; how rules work (`none`, `rules`, `agreement`); the ask-first lines and channel manners.
  Answers write `house.toml`; `--answers <file>` makes it non-interactive. The agent records the operator's words and
  drafts nothing on their behalf.
- **Adopt** (`lampstand adopt`): every proposed item is shown verbatim with its size against the budget; choices are
  adopt, edit, strike or later, default later. No recommendation is ever offered. `--ids a,b` for CI. Each act is
  recorded in `charter/record.md`; a struck item is not proposed again unless its text changes.
- **Propose** (`lampstand propose principle|provision|reflex`): requires an occasion (what happened that calls for
  it). Principles and provisions wait for the operator's adopt; reflexes are admitted by the agent under `curation.md`.

### Curation rules (objective only; pinned by an exact-equality test)

Every new principle, provision or reflex carries an occasion; every principle carries a failure mode; every reflex
carries a falsification trigger and a revision step; budgets and the ratchet hold; no declared totals; generated files
carry their header and match a fresh compile; every gate a provision names exists; at most five unconditional surfaces.
Editorial judgements are never errors: they are reported as information or not at all.

## 8. The org substrate

Tasks, inbox items, decisions, knowledge and reminders are Markdown files with frontmatter. The schema is data
(`schema/org.json`: kinds, statuses, folders, required fields) that `house.toml [org]` may extend. One frontmatter
parser (U1's) reads every file.

- Verbs: `lampstand task|inbox|decide|capture|knowledge|remind|status|lint|relink`, plus `lampstand forge new|log|status`
  for multi-agent pipelines (a manifest under `forge/sessions/`, an append-only execution log whose timestamps the tool
  writes, never the caller).
- Lifecycle: an item reaching a terminal status gets `resolved:` (date) and a one-line `resolution:` naming where the
  work landed, and moves to its kind's `resolved/` folder in the same act.
- `lampstand lint` is objective-only: an error is a state that is wrong on the file's own evidence (a missing required
  field, a status outside the schema, a dangling link, a resolved item outside `resolved/`); anything that depends on
  intent is information or nothing.
- Orientation (`lampstand status --orient`) prints counts and only the problems: STALE, NOT_LANDED, REJECTED, a stale
  projection, a schema newer than the code. Budget: the dynamic orientation cap.

## 9. Write governance and the scheduler

- Jobs are declared in `house.toml [jobs.<id>]`: `argv`; `every`, `at` or a cron string; `stale_hours`; `outputs`
  (path prefixes it may create); `mutates` (existing files it may replace); `commit` (`false`, `true` or `"push"`);
  `cost_ceiling_usd`; `env` (variable names only).
- `lampstand run <job>`: take the job's lock row; create a staging dir and set `HOUSE_RUN_OUT`, `HOUSE_ROOT`,
  `HOUSE_RUN_ID`; execute; validate every staged path against `outputs` (one violation lands nothing: outcome
  `rejected`); land new files by atomic rename, and a `mutates` file only if its live hash still equals its hash at
  staging; `git add` exactly the landed paths, commit, and verify `git show --name-only HEAD` equals them (otherwise
  `not_landed`); write the ledger row. **No step ever reads `git status`.**
- `lampstand tick` is the one OS entry per house, every 15 minutes (a per-user Task Scheduler task, a systemd user
  timer, launchd, or a crontab line): it runs due jobs (one catch-up after sleep) and `doctor --quick`, writes one
  deduplicated capture on failure, and is silent on success.
- Health is the last landed outcome within `stale_hours`; orientation prints only STALE, NOT_LANDED and REJECTED.
- Zero autonomy at install: the scheduler module is off; `init` proposes two starter jobs (`check`, `doctor --quick`)
  and registers nothing until `lampstand scheduler enable` lists every OS entry it will create and asks once. No push
  by default; doctor refuses automatic push to a public remote.

## 10. Host adapters

Each host loads the projections by role. The kernel is never loaded twice: every projection begins with a marker line
`<!-- lampstand:<projection> -->`, and an adapter adds a projection only when its marker is absent from what the host
already carries.

| Role | OMP (`hosts/omp/index.ts`) | Hermes (`hosts/hermes/*.py`) |
|---|---|---|
| Kernel | first in the house's `AGENTS.md` region (main sessions) and in W (subagents) | a plugin prompt section `lampstand-kernel` (<= 4,000 chars after formatting); when the house's `AGENTS.md` region will load in this session, the section is a one-line pointer instead |
| Router | the `AGENTS.md` region (K plus router sections up to 12,000 chars), then on `before_agent_start` the adapter appends to the system prompt any router section whose marker is absent (the system prompt is re-prepared per request and never compacted) | the `AGENTS.md` region, a context-file slot; a nested repository whose context file shadows the house's gets K plus a pointer |
| Worker | `before_agent_start` in a subagent (`ctx.agent.kind === "sub"`) appends W and no router section | a `lampstand_delegate(role, goal, context)` tool composes `agents/<role>.md` with W and launches a leaf child through the plugin subagent API (`ctx.subagent_lifecycle`); the host's own `delegate_task` needs the classic CLI's parent agent and fails in gateway, TUI and desktop sessions |
| Watchdog | `WATCHDOG.md` in the house imports G (opt-in) | none |
| Dynamic orientation | one `session_start` message for the next turn (compactable by design) | the first turn's `pre_llm_call` |
| Maintenance gate | `session_stop` (main sessions only) asks `gate.js` and, in `remind` mode, adds one reminder at most once per session after a turn that edited files; `block` blocks | `pre_verify` where the host offers it; otherwise remind on the next turn |

Rules for both adapters:

- **No CLAUDE.md is planted.** OMP subagents inherit every context file except `AGENTS.md`, so a CLAUDE.md importing
  `AGENTS.md` would hand the router to every subagent.
- **OMP:** register no `tool_call`, `tool_result`, `tool_approval_requested` or `tool_approval_resolved` handler (any of
  them switches off the host's speculative tool execution); every session-level handler returns early when
  `ctx.agent?.kind === "sub"` unless it is the worker loader; the extension factory has no side effects; it self-gates
  on the host version and prints one notice below the floor.
- **Hermes:** `register(ctx)` does no subprocess, socket or network work and finishes under one second (file stats
  only); Python uses the standard library only; Node is found on PATH, then at `$HERMES_HOME/node`; the plugin never
  writes `SOUL.md` and sets config keys only through `lampstand setup` with consent per key. The floor is Hermes
  0.22.6, the first release whose install scan rates the plugin safe (0.22.3 rates it caution and blocks a
  non-interactive install); 0.22.3 first reported the session's cwd and surface. Surfaces with a workspace are
  `cli`, `tui`, `desktop`, `acp`, `subagent` and the empty surface; messaging platforms and `cron` have none, so only
  they may resolve `default_house`. The kernel cap is measured after the framing Hermes renders around a plugin
  section (79 characters for the `lampstand-kernel` id).
- A stale projection (input hash mismatch) is still loaded, with a one-line notice naming `lampstand compile`.

## 11. Init, upgrade and the seat

- `lampstand init [<dir>] [--answers <file>] [--default]` plants a house: missing files only, never overwriting;
  a re-run is byte-identical. It writes `house.toml`, the constitution templates (with the lattice unless declined),
  the org folders, `AGENTS.md` with its generated region, `.gitattributes`, `projects/README.md`, `.house/planted.json` (every planted file
  with its hash), runs `git init` when the directory is not a repository, and compiles the projections. `--default`
  records the house as `default_house` in per-user config.
- `lampstand upgrade`: plugin code upgrades through the host's own command; this verb migrates the house. It backs up
  `house.toml` and `.house/`, applies forward migrations, recompiles, and writes every change to a planted file the
  user has edited (its hash differs from `planted.json`) as a proposal in `proposals/updates/` instead of writing it.
  It refuses a house whose `[plugin] min` or schema is newer than this lampstand.
- `lampstand seat status|reset`: every write outside the house that needed consent (a git hook, an OS scheduler entry,
  a host config key) is recorded in `seat.json` with its before-value; `reset` restores them newest first.
- Uninstall leaves the house byte-identical; `lampstand seat reset` is the only verb that removes per-machine traces.

## 12. Doctor

`lampstand doctor [--quick] [--json]`. Checks are objective only; each finding has a stable code. Exit codes: 0
healthy; 1 broken and fixable by a re-run, `lampstand compile`, `lampstand upgrade` or a restart; 2 broken and a
person must act (a schema newer than the code, a double load, a missing runtime); 3 no house here or setup unfinished.

| Area | Checks |
|---|---|
| Core | the marker and `HOUSE_ROOT`; `house.toml` against its schema; projections against their input hash; budgets within host envelopes; `house.db` opens at a known version; the state dir is local; each enabled job's last landed outcome within `stale_hours` and its OS entry pointing at this house; `node` or `bun`, and `git`; proposals waiting (information) |
| OMP | host version at or above the floor; the extension loaded twice (plugin plus an `extensions:` path); files in the user's own OMP folders that shadow the plugin's agents, rules or skills (information) |
| Hermes | the plugin enabled; Node resolvable; which context file loads here (information); the kernel section skipped from the shared prompt budget |
| Rooms | agora at or above the release with the room-safety fixes; no channel attached both to a Hermes platform and to an agora room |

`--quick` runs only the core checks that need no network and no host process.
