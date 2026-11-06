<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vincitamore/lampstand/dev/docs/assets/lampstand-lockup-dark.svg">
    <img alt="lampstand" src="https://raw.githubusercontent.com/vincitamore/lampstand/dev/docs/assets/lampstand-lockup-light.svg" width="520">
  </picture>
</p>

**lampstand turns one Hermes into a team that remembers who it works for.** Plant a house (a git repository you own)
and every chat started in it works under the same written principles and rules, keeps one shared record of tasks,
decisions and knowledge, and can wake the other chats, or be woken by them, through shared rooms, including from your
phone. Nothing becomes a rule until you adopt it, and every change is a commit you can read, diff and keep.

It installs as a plugin into [Hermes Agent](https://github.com/NousResearch/hermes-agent) and
[OMP](https://github.com/can1357/oh-my-pi).

## What it does

| You get | How | Where |
|---|---|---|
| Every chat starts from the same house | the house's files compile into a short kernel (purpose, a line per principle, what always needs asking first) loaded at the start of every session; the first turn adds what is open now | every session inside a house |
| The house as native tools | tasks, inbox, decisions, knowledge, reminders and proposals as plain Markdown, each change its own git commit | Hermes tools and `/lampstand`; the `lampstand` CLI anywhere |
| A cockpit | the Hermes Desktop House page: five lamps for the house's health, work, inbox, knowledge, the constitution with adopt and strike, rooms and rhythm | Hermes Desktop |
| Rules only you enact | the agent drafts principles, rules and habits with the occasion that called for each; adopting a principle or a rule is refused from an agent's shell | always |
| Subagents that carry your principles | a worker projection: the kernel plus the habits scoped to that host, at a fraction of the main context | Hermes `lampstand_delegate`; OMP subagents |
| Chats that wake each other | [agora](https://github.com/vincitamore/agora) rooms: each chat listens under its own name, answers in the room, is never woken by itself, and a hop cap stops loops | Hermes and OMP, with agora installed |
| The room on your phone | `/lampstand relay <room>` in a Telegram, Discord, Slack or other Hermes chat: what you type goes into the room, and Hermes tells you what the room says | Hermes messaging |
| A check before a turn ends | the maintenance gate lists what the session owes the house (a task updated, state written down) | Hermes and OMP |
| Fixed jobs that tell you only when one did not land | declared outputs, verified commits, one OS scheduler entry per house | the scheduler module turned on |

Parallel work is your host's own feature (Hermes delegation, OMP subagents and background jobs); lampstand gives each
worker the right context and keeps their results in the house.

## Quick start

lampstand needs Node 22.13 or newer (or Bun) and git.

```sh
# Hermes (say yes to enabling; lampstand has no Node dependencies, so answer no to that question)
hermes plugins install vincitamore/lampstand

# OMP
omp plugin install "github:vincitamore/lampstand#v0.3.0"

# the CLI on your own PATH
npm install -g "github:vincitamore/lampstand#v0.3.0"

# plant a house
lampstand init ~/my-house
```

`init` asks where the house lives, its name, who has care of it, what the work is for, how rules are made and which
actions always need asking first, then whether to plant the default principles. It plants the house and compiles what
your agent will load. Start a chat in the folder (`cd ~/my-house`, or pick it as the chat's folder in Hermes Desktop)
and the agent starts from your house. [Install on Hermes](docs/install-hermes.md) covers the House page, rooms and the
phone relay.

## The principles

Every house starts from a set of principles unless you decline them with `--no-lattice`: the lattice, thirteen
principles for judging work, drawn from classical and Christian philosophy and from engineering practice. Each names
the failure it guards against, and each gives every session one line to carry. Two of them, as a session loads them:

> **Structural Correctness Over Functional Adequacy.** Be right over the operations the structure must support over
> time, not the sample tested; name that space.
>
> **Primitives Over Opinions.** Expose primitives and let the consumer compose; ship defaults on top of the
> primitives, never as them.

`init` explains the pack before it asks, then plants it as your own copy. Edit it, strike what does not fit, or add
your own; new versions of the pack arrive as proposals and never overwrite your copy. The text is public domain
(CC0).

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
