<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vincitamore/lampstand/dev/docs/assets/lampstand-lockup-dark.svg">
    <img alt="lampstand" src="https://raw.githubusercontent.com/vincitamore/lampstand/dev/docs/assets/lampstand-lockup-light.svg" width="520">
  </picture>
</p>

lampstand gives your coding agent a house: a git repository you own that holds the principles and rules it works
under, its tasks, decisions and knowledge, and the machinery that keeps them true. It installs as a plugin into
[OMP](https://github.com/can1357/oh-my-pi) and [Hermes Agent](https://github.com/NousResearch/hermes-agent). Every
session in the house starts from the same principles; every subagent gets a short kernel of them; and the work stays in
plain files you can read, diff and keep.

## What it does

| You get | How | When it holds |
|---|---|---|
| One agent, continuous across sessions and model changes | the house's files are compiled into what each session loads at start: a kernel of your principles, then the full text for main sessions | always, inside a house |
| Subagents that carry your principles at a fraction of the main context | a worker projection: the kernel plus the habits scoped to that host | OMP subagents; Hermes through `lampstand_delegate` |
| Your work in plain files you own | tasks, decisions, investigations, knowledge and reminders as Markdown with frontmatter, moved and linked by `lampstand` verbs | always |
| A check before a session ends | the maintenance gate lists what the session owes the house (a task updated, current state written down) and can block until it is done | OMP; Hermes where it offers `pre_verify` |
| Fixed jobs that tell you only when one did not land | declared outputs, verified commits, one OS scheduler entry per house | the scheduler module turned on; the machine awake at the scheduled time |
| Sessions woken by messages in shared rooms | [agora](https://github.com/vincitamore/agora) rooms, with an author allowlist checked before any wake | agora installed; OMP |

Parallel work is your host's own feature (OMP subagents and background jobs, Hermes delegation); lampstand gives each
worker the right context and keeps their results in the house.

## Quick start

lampstand needs Node 22.13 or newer (or Bun) and git.

```sh
# OMP
omp plugin install "github:vincitamore/lampstand#v0.2.0"

# Hermes (asks before enabling; lampstand has no Node dependencies, so answer no to that question)
hermes plugins install vincitamore/lampstand

# the CLI
npm install -g "github:vincitamore/lampstand#v0.2.0"

# plant a house
lampstand init ~/my-house
```

`init` asks six questions (where the house lives, its name, who has care of it, what the work is for, how rules are
made, which actions always need asking first), plants the house, and compiles what your agent will load. Open a
session inside the folder and the agent starts from your house.

## The principles

Every house starts from a set of principles unless you decline them with `--no-lattice`: the lattice, thirteen lenses
for judging work (inversion, single source, structural correctness, coherence, and others), each with the failure mode
it guards against. `init` plants it as your own copy. Edit it, strike what does not fit, or add your own; new versions
of the pack arrive as proposals and never overwrite your copy. The text is public domain (CC0).

## How rules are made

Pick one at `init`; change it any time with `[charter] mode` in `house.toml`:

- `none`: principles only, no written rules.
- `rules`: you enact rules; the agent drafts them as proposals with the occasion that called for each.
- `agreement`: a written agreement between you and the agent, with undertakings on both sides, kept in
  `charter/core.md`.

## Learn more

- [Concepts](docs/concepts.md): what a house is, what loads when, and how lampstand relates to other agent systems.
- [Install on OMP](docs/install-omp.md) and [on Hermes](docs/install-hermes.md).
- [First run](docs/first-run.md): plant, adopt, propose.
- [Security](SECURITY.md): what lampstand writes, what it runs, and the install scan.

## Credit

The DeepSeek Harness team's article "Exploring Super-agent Design" set out why agents outgrow a single session: a
long-lived router with isolated workers, work driven by events, interaction that does not block, state kept apart from
compute, and a watchdog. lampstand takes several of those ideas into the house, and adds the part a house needs on top:
the principles and rules the agent works under, kept as files its operator owns. No code from their prototype is used.

## License

Code: MIT. The principle and charter text in `packs/` and `templates/`: CC0 1.0.
