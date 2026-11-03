---
name: house
description: "Working inside a lampstand house: where its principles, charter, reflexes, tasks, decisions and knowledge live, the lampstand verbs that change them, and what a session owes the house before it ends. Use whenever the working directory is inside a house (a house.toml above it), when asked to record, resolve, propose or adopt anything there, or when orientation reports a problem. Not for designing multi-agent work (the orchestrate skill) or curating principles (the curate skill)."
---

# Working inside a house

A house is a git repository its operator owns. It holds the principles and rules you work under and the work itself,
as plain files. The lampstand plugin compiles the normative files into what your host loads at session start, and gives
you verbs that keep the rest true. The files are the record; the per-machine database only counts things.

## §0 Keeping this skill true

Update this file in the same change that moves the fact it describes: a verb added, renamed or retired; a folder that
moves; a rule about what a session owes. Remove a line the moment it stops being true rather than adding a correction
beside it.

## What is where

| Path | Holds | Who changes it |
|---|---|---|
| `house.toml` | the house's identity, purpose, charter mode, modules, budgets, jobs | the operator |
| `principles/` | the lenses every judgement goes through | the operator adopts; you may propose |
| `charter/` | how rules are made, the provisions in force, the record of each enactment | the operator enacts; you draft |
| `reflexes/` | learned working habits, each scoped to behaviour, architecture or one host | you, under `curation.md` |
| `voice.md` | how to collaborate and how to speak on each channel | you, from what you observe |
| `state/current.md` | standing reality now, kept short | you |
| `tasks/`, `inbox/`, `knowledge/`, `reminders/` | the work | you, through the verbs |
| `proposals/` | drafts waiting for the operator; never loaded | you propose; the operator adopts |
| `.house/generated/` | compiled projections; never edit by hand | `lampstand compile` |

What your host loaded at session start is the kernel (purpose, every principle's thesis and failure mode, the
ask-first lines) and, in a main session, the router (the full principles, the charter, the reflex index, voice).
A subagent gets the kernel and the reflexes for its host only.

## The verbs

Run `lampstand <verb> --help` for flags; add `--json` for one machine-readable object.

- **Work:** `task new|list|set|done`, `capture "<text>"`, `inbox new|list|set`, `decide new|resolve`,
  `knowledge new|list`, `remind new|list|done`. Pass long Markdown as `--body -` on stdin (`capture -` likewise), never
  inside shell quotes: a backtick in double quotes runs as a command, and on Windows the `lampstand.cmd` shim refuses
  many quotes and parentheses in an argument (`batch file arguments are invalid`).
- **Truth upkeep:** `status --orient`, `lint`, `relink <old> <new>` (after any move), `compile [--check]`.
- **The constitution:** `propose principle|provision|reflex <file> --occasion "<what happened>"`, `adopt` (the
  operator's act, item by item, committed). The file is `<slug>.md` (lowercase letters, digits, hyphens);
  `propose <kind> --help` prints its minimal shape. A provision is `# Title`, a blank line, then the text; `propose`
  adds `occasion` and `proposed` to the frontmatter itself.
- **Pipelines:** `forge new|log|status` (see the orchestrate skill).
- **Jobs:** `run <job>`, `run --status`, `tick`, `scheduler enable|disable|status` (the scheduler is off until the
  operator turns it on with `[modules] scheduler = true`). A job is a `[jobs.<id>]` table in house.toml with `argv` and
  `stale_hours` required, and `every`, `at`, `outputs`, `mutates`, `commit` optional; `run --help` shows an example.
- **The house itself:** `init`, `upgrade`, `doctor`, `seat status|reset`, `root`, `gate`.

## Rules that hold every session

1. **Resolve in the same breath as the work.** When a task, decision or investigation is done, close it with
   `--resolution "<one line naming where it landed, as a [[link]]>"`. Only `dropped`, `withdrawn` and `abandoned` take
   a plain reason instead; every other terminal status needs the link. The verb moves the file to `resolved/` and
   fixes links. Never leave resolution for a later tidy-up.
2. **Files are written through verbs** where a verb exists. Hand edits to frontmatter skip the checks the verbs make.
3. **A changed normative file is recompiled.** After editing anything under `principles/`, `charter/`, `reflexes/` or
   `voice.md`, run `lampstand compile`; `compile --check` failing means the projections are stale.
4. **Ask first** before anything on the ask-first list in `house.toml`. `init` plants these defaults unless the operator
   declined them (irreversible deletes, history rewrites, publishing or pushing, spending, messaging people outside
   the house, secrets or private data leaving, live systems), then their own lines; an older house has only what its
   operator wrote. The list is the operator's; follow it even when the action looks harmless. A request that names the
   act is consent to that act as named, never to a wider scope: when what it covers is open, ask which is meant.
5. **Never adopt for the operator, and never recommend in an adopt.** The CLI refuses principles and provisions from
   your shell (`E_OPERATOR_ONLY`); only reflexes are yours to admit. You may propose with an occasion; the operator
   decides. Whoever is judged by a lens does not shape it.
6. **Orientation shows only problems.** If it reports STALE, NOT_LANDED, REJECTED, a stale projection or a newer
   schema, deal with that before new work or tell the operator why not.
7. **Commit as the work lands.** The house is its git history; work left uncommitted is not yet the house's. Commit
   each finished piece in a small commit that says what changed, naming only the paths you changed. Pushing is the
   operator's call unless they have said otherwise. A provision in the charter about commits overrides this rule.

## Before the session ends

The maintenance gate (`lampstand gate <changed paths>`, run by your host for you) lists what the session owes: a task
updated or resolved, `state/current.md` brought up to date, a reusable lesson written to `knowledge/`, a decision filed
in `inbox/decisions/` with its options, a resolution recorded. A proposal owes none of these, and a changed
constitution file owes only `lampstand compile`. Do each that is owed, or say plainly why it is not owed. In `block`
mode the session cannot end until the list is empty. Then commit what is left of the session's work (rule 7).
