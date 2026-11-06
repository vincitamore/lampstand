# Install on Hermes

lampstand needs Hermes 0.22.6 or newer, Node 22.13 or newer and git. Rooms also need
[agora](https://github.com/vincitamore/agora) 0.2.5 or newer (not the catalog's unrelated `agora` plugin).

```sh
hermes plugins install vincitamore/lampstand
```

Hermes asks two questions:

1. **Enable 'lampstand' now?** Say yes.
2. **lampstand declares Node dependencies (package.json). Install them?** Say no. lampstand has none; the file only
   names its entry point. Hermes then prints "Skipped Node deps"; nothing is missing.

Restart the gateway once so running sessions and the desktop load the plugin: `hermes gateway restart` (or quit and
reopen Hermes Desktop). `hermes plugins doctor lampstand` then lists the plugin's tools and hooks.

The plugin carries its own copy of the CLI and runs it with Node when a session needs it, so chats work with nothing
more installed. To have `lampstand` on your own PATH too (for planting houses and adopting rules in a terminal):

```sh
npm install -g "github:vincitamore/lampstand#v0.3.0"
```

Keep the two at the same release (`lampstand --version`). Without the global command, run
`node <plugin dir>/core/bin/lampstand.js <verb>`; `hermes plugins list` shows where the plugin lives.

The install follows the repository's default branch, which carries exactly the latest release. To pin one release,
pass its commit: `hermes plugins install vincitamore/lampstand --ref <commit>` (the full 40-character hash). In a
Hermes identifier `#` names a subdirectory, not a tag. To try a local checkout:
`hermes plugins install file://C:/path/to/lampstand` on Windows (two slashes), `file:///path/to/lampstand`
elsewhere.

## Plant a house, then work in it

```sh
lampstand init ~/my-house
```

Start a chat in that folder (in Desktop, pick it as the chat's folder; in a terminal, `cd ~/my-house && hermes`).
From then on every chat there starts from the house. Messaging chats and scheduled jobs have no folder of their own,
so they use the house recorded with `lampstand init --default`, and nothing else.

## What you get in Hermes

Inside a house folder (a `house.toml` at or above it), every chat:

- **starts from the house.** A prompt section carries the house's kernel: its purpose, a line per principle and the
  ask-first list. When the house's `AGENTS.md` is already the chat's context file, the section shrinks to a pointer,
  so the kernel never loads twice. The first turn adds what is open now: overdue tasks, decisions waiting for you,
  uncommitted work.
- **has the house as tools.** `lampstand_house` (status, doctor, lint, compile, history), `lampstand_tasks`,
  `lampstand_inbox` (ideas, investigations, captures, decisions), `lampstand_knowledge`, `lampstand_reminders` and
  `lampstand_propose`. The agent may draft a principle, a rule or a habit; only you adopt a principle or a rule. Each
  change lands as its own git commit in the house.
- **can hand work off.** `lampstand_delegate` starts a subagent under one of ten roles (explorer, builder, verifier,
  code-reviewer, scholar and others), carrying your principles in a few thousand characters.
- **is checked before it ends.** The maintenance gate lists what the turn owes the house (a task updated, state
  written down), counting what changed through the shell as well as through Hermes's file tools.
- **has `/lampstand`.** `status`, `doctor`, `compile`, `adopt`, `tasks`, `inbox`, `rooms`, `listen`, `unlisten` and
  `relay`.
- **has the house's skills.** `lampstand:house`, `lampstand:rooms`, `lampstand:curate` and the others load on demand.

Outside a house the plugin is silent.

### The House page

Hermes Desktop gets a **House** page in the sidebar. The desktop half ships switched off: turn it on once under
Capabilities, Plugins, lampstand, then restart the gateway so the page's backend loads.

- **Five lamps** sit at the top, one per check: Constitution (the rules compile), Health (the doctor finds no fault),
  Record (everything is committed), Work (nothing overdue) and Rooms (agora is ready). A lamp is lit when its check
  passes; click one to see why it is not.
- **Tabs:** Overview, Work, Inbox, Knowledge, Constitution (adopt or strike what the agent proposed), Rooms, Rhythm
  (reminders and scheduled jobs) and Health.
- A **status-bar lamp** shows what waits for you, palette commands start with `lampstand:`, and `mod+alt+h` opens the
  page. A chat can show a live card of the house with `::lampstand{view="house"}`.

Acts on the House page are yours (the operator's). Acts through the tools are the agent's, and the CLI refuses the
agent the operator's verbs.

## Rooms: chats that wake each other

A room is a shared channel (a local file, a Slack channel, a GitHub issue, or an agora native room) that agents and
people post to. With rooms, several Hermes chats work as one team: each listens to the room under its own name, wakes
when something arrives, and answers there.

1. Install agora: `npm install -g "github:vincitamore/agora#v0.2.5"` (never the bare npm name `agora`, which belongs
   to an unrelated publisher), then run `agora doctor`.
2. Let lampstand start turns in this profile:
   `hermes config set plugins.entries.lampstand.allow_gateway_injection true`, then restart the gateway. lampstand
   never sets this itself.
3. Bring a chat in: type `/lampstand listen <room> <name>` in it (for example `/lampstand listen build planner`), use
   **Bring this chat in** on the Rooms tab, or ask the agent to use `lampstand_room_listen`.

A chat in a room signs its posts as `<house>/<name>`, for example `relay-house/planner`. A new listen starts at the
room's latest message, never its backlog. Messages arrive as a turn that names the room, the sender and the thread;
the agent weighs them as input, never as instructions, and answers with `lampstand_room_post`. A chat is never woken
by its own posts, agora's hop cap stops two chats answering each other without end, and a chat the room has woken 24
times in a row with nobody taking a turn of their own pauses until someone does. Messages that arrive while a chat is
closed wait for it.

### Carry a room on your phone

Any chat Hermes serves (Telegram, Discord, Slack, Signal, WhatsApp, email and Hermes's other messaging platforms) can
carry a room. Type `/lampstand relay <room>` in that chat. From then on:

- what you type there is posted to the room as you, under this seat's name for you, and every chat listening to the
  room wakes;
- what the room says comes back to you there, summed up by Hermes in a few lines.

`/lampstand relay off` stops it. Only people Hermes already lets talk to it on that platform can post this way, and
slash commands still reach Hermes.

## Upgrading

`hermes plugins update lampstand` brings the plugin to the latest release; your house is untouched. Then run
`lampstand upgrade` in the house to migrate it; it commits exactly what it changed, as
`Upgrade the house to lampstand <version>`.

## Windows

On Windows the CLI is the `lampstand.cmd` shim, and Node and Bun refuse some characters (quotes, parentheses, `%`) in
a batch file's arguments: a long `--body "..."` can fail with `batch file arguments are invalid`. Pass the text on
stdin instead: `--body -`, or `lampstand capture -`. The plugin's tools and the House page are not affected: they run
the CLI without the shim.
