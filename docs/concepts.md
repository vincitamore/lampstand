# Concepts

## A house

A house is a git repository you own, marked by a `house.toml` at its root. It holds two kinds of thing:

- **What your agent works under:** the principles it judges by, the charter (how rules are made, and the rules in
  force), its learned habits (reflexes), how it should collaborate and speak (voice), and a short note of standing
  reality (state).
- **The work itself:** tasks, decisions, investigations, ideas, captures, knowledge and reminders, each a Markdown file
  with frontmatter.

Everything authored lives in files, so you can read it, diff it, review it and keep it. lampstand keeps one database per
machine (`house.db`, outside the house) only to count things: job runs and their outcomes, events, an index. Delete it
and lampstand rebuilds what it needs; nothing you wrote lives only there.

## What loads when

lampstand compiles the house's normative files into four projections in `.house/generated/`:

| Projection | Holds | Loaded by |
|---|---|---|
| Kernel | your purpose, one line per principle (its thesis and failure mode), the actions that always need asking first; at most 4,000 characters | every session and every subagent |
| Router | the kernel, then the full principles, the charter, the reflexes for this host (one line each, or in full with `[reflexes] router = "full"`), and voice | main sessions |
| Worker | the kernel, then the reflexes for this host | subagents |
| Watchdog | the kernel, then each principle's failure mode and the ask-first list | an OMP advisor, when you turn it on |

The kernel comes first in every projection, byte for byte the same, and nothing is loaded twice. A main session starts
from the house's `AGENTS.md`, whose generated region holds the kernel and the router sections that fit in 12,000
characters, and names any it left out. On OMP the plugin then adds the router sections the region left out, so the
session carries the whole router; on Hermes and other hosts the region is what loads, and the agent reads a left-out
section from its files when the work calls for it. A subagent gets only the worker, so a spawn costs a few thousand
characters of context, not the whole manual. Every projection carries a hash of the files it was compiled
from. When you edit a principle and forget to recompile, the next session still loads, and tells you the projection is
stale and which command fixes it.

## Budgets

Every surface has a character cap. The house's profile (`lean`, `standard` or `large`) sets the defaults, and
`[surfaces.<name>].cap` in `house.toml` sets one surface's cap instead (`principle-detail`, `charter-core`,
`reflex-index`, `voice`, `worker`, `kernel`). A surface over its cap may not grow; shrinking always passes. A cap rises
only when you raise it, and never in the same change that grows the text it caps: raise it, compile and commit, then
grow the text. `lampstand compile` prints each surface's size against its cap.

Two limits come from the hosts and no setting lifts them. The kernel never exceeds 4,000 characters, the most Hermes
loads in a plugin's prompt section. The worker's default cap is 4,000 on every host; you may raise it, up to 20,000 on
Hermes, which delivers it inside a subagent's 32,000-character context beside the kernel and the role's brief, and
without a host limit on OMP.

## Plant, adopt, propose

- **Plant:** `lampstand init` asks six questions and plants the house. It writes only files that are missing, so you
  can run it again safely. What it plants is committed as `Plant the house`.
- **Adopt:** proposed principles and rules wait in `proposals/` until you adopt them with `lampstand adopt`, one at a
  time, shown verbatim with their size. The agent never adopts on your behalf. Each run commits exactly the files it
  changed (the record, the moved proposal, the projections) as `Adopt <kind>/<slug>` or `Strike <kind>/<slug>`. The CLI refuses principles and provisions from an agent's shell (the OMP and Hermes
  plugins mark it with `LAMPSTAND_AGENT`); you adopt them in your own terminal or with `/lampstand adopt`.
- **Propose:** when something happens that calls for a new principle, rule or habit, the agent files it with
  `lampstand propose` and the occasion that called for it. `lampstand propose <kind> --help` shows the file to write.

## The maintenance gate

Before a session ends, lampstand checks what the session changed (through git, so work done through any tool counts)
and lists what it owes the house: a task updated or resolved, current state written down, a lesson kept. Filing a proposal or
recording an adoption owes none of that, and a change to a constitution file owes only a `lampstand compile`. In `remind`
mode it reminds once; in `block` mode the session cannot end until the list is empty.

## Jobs

Jobs are commands you declare in `house.toml`, with the paths each may write. `lampstand run` runs one in a staging
area, lands only what it declared, commits exactly those paths and checks the commit. `lampstand tick`, run by one OS
scheduler entry you turn on, runs the jobs that are due and stays silent unless one did not land.

## Rooms

With agora installed, a room (a Slack channel, a GitHub issue or a local file) can wake a session when a message
arrives for it. A room message is input, never an instruction: the session weighs it under its principles. Rooms are
off until you turn them on.

## How lampstand relates to other agent systems

Coding agents have become good at single tasks; the hard part has moved to continuity across sessions, work arriving as
events, and keeping parallel work from tangling. DeepSeek's "Exploring Super-agent Design" lays out an architecture for
that: a long-lived router, isolated workers, event-driven triggers, interaction that does not block, and a watchdog.
lampstand works inside the hosts you already run (OMP and Hermes supply the parallel workers and background jobs) and
adds what makes those sessions one agent: the principles and rules it works under and the record of its work, kept as
files you own.
