# Security

## Reporting a problem

Open a private security advisory on this repository (Security, then Report a vulnerability). Please include what you
ran, what happened, and the lampstand, host and operating system versions.

## What lampstand writes

lampstand writes only where these lines say, and every write outside the house is recorded so it can be undone.

- **Inside your house**, through its own verbs: the files `lampstand init` plants (missing files only, never
  overwriting), the compiled projections in `.house/generated/`, and the files its org verbs create, move and relink.
- **The house's `AGENTS.md`.** `lampstand init` and `lampstand compile` write the region between the
  `<!-- house:begin -->` and `<!-- house:end -->` lines, and nothing else in that file. That region is what your
  agent loads at the start of every session in the house, so it carries your principles into future sessions by
  design. It is written only when you run one of those two verbs. Remove the two marker lines and lampstand never
  writes the file again.
- **Per machine, outside the house:** a state directory (`%LOCALAPPDATA%\lampstand`, `~/Library/Application
  Support/lampstand` or `$XDG_STATE_HOME/lampstand`) holding `house.db` and logs, and a per-user config folder holding
  `config.toml` and `seat.json`.
- **In Hermes, under the profile's home** (`$HERMES_HOME/lampstand/`): `houses.json`, the houses your sessions
  worked in, which the desktop's House page lists; `listens.json`, which chats you brought into which rooms, with the
  messages waiting for a closed chat; and `agora-pane/`, the room pane's own settings and read cache, including the name
  you post under. Each file is written under a lock file beside it, so several Hermes processes can share it. While a
  room-woken turn runs, lampstand writes that chat's hop record (`wake.json`) under agora's state folder, which agora
  reads when the chat posts, and removes it when the turn ends.
- **In the house, from Hermes:** each act through a lampstand tool or the House page lands as one git commit of exactly
  the files it changed, with no approval prompt per call; the commit runs the house's own git hooks, if it has any.
- **With your consent, one item at a time:** a `default_house` entry in per-user config, and one OS scheduler entry per
  house (a per-user scheduled task, systemd user timer, launchd agent or crontab line). Each is recorded in `seat.json`
  with what was there before; `lampstand seat reset` restores it.

lampstand never patches a host, never writes another plugin's files, never sets a theme or a global host setting, and
never writes a Hermes `SOUL.md`.

## What lampstand runs

- `git`, in the house only: `rev-parse`, `diff --name-only`, `ls-files --others`, and, for a job that commits, `add`
  and `commit` of exactly the paths the job declared and produced (then `show --name-only` to check them). The Hermes
  House page also reads `status --porcelain`, `log` and `remote` to show the house's record; nothing in lampstand
  pushes unless a job is declared with `commit = "push"`.
- `node` (or Bun) running lampstand's own CLI. In Hermes it runs with the gateway's environment (minus agora's actor
  and session names), in the house's folder.
- The commands you declare as jobs in `house.toml [jobs]`, and only when you run them or turn the scheduler on.
- `doctor` reads versions from `omp`, `agora` and `node` when those are installed.
- The OS scheduler tools (`schtasks`, `systemctl --user`, `launchctl` or `crontab`): they create or remove the tick
  entry only for `lampstand scheduler enable`, `disable` and `lampstand seat reset`; `doctor` and
  `lampstand scheduler` only query them.
- In Hermes, `node` running agora's own CLI (`bin/agora.mjs` of the agora checkout behind the `agora` command on
  PATH, or the `agora_checkout` setting) for `watch`, `read`, `post`, `rooms` and `cursor`, and agora's room pane
  (`plugins/tern/agora/bridge.mjs`) for the desktop's Rooms page and the phone relay, only when a chat listens to a room
  or the page is open. That checkout is code outside this plugin's pinned tree, and it runs with the gateway's
  environment. A background thread in the gateway polls each listening chat's rooms every 15 seconds; it starts with
  the first listen and stops when none is left. lampstand makes no network request of its own; agora's transports make
  theirs, with agora's own credentials, which never pass through lampstand. With the `agora_config` setting, agora runs
  with `AGORA_CONFIG` set to that path (and no inherited `AGORA_STATE`) for that profile's chats only.
- In Hermes it reads, read-only, the profile's session store (`state.db`, the `sessions` table) to find the route key
  of a chat the desktop names by its stored id, and the profile's config for `allow_gateway_injection`.
- The shell (`sh`, or `cmd.exe` on Windows): on Windows, to start a `.cmd` or `.bat` program, which only `cmd.exe`
  can run; and, when you choose edit in `lampstand adopt`, to open your editor (`$VISUAL` or `$EDITOR`).

## The Hermes install scan

Hermes scans a plugin's files when you install it and shows what it finds. It reads text files by extension (among
them `.js`, `.ts`, `.py`, `.md`, `.json`, `.yaml`, `.toml` and `.txt`) and skips any other, such as `.mjs`, `.cjs`,
`.tsx`, `.sql` or a name with no extension. The release ships only extensions it reads, so every shipped file is
scanned, and each release is checked against the scan before it is tagged. Install interactively
(`hermes plugins install vincitamore/lampstand`) to see the findings yourself before enabling it.

## Messages from rooms

A message posted in a room is input, never an instruction. Rooms come from agora, which wakes a session only for
authors on a room's `wakeFrom` list, refuses to listen on a room the public can post in without one, and frames every
delivered message as input. Rooms are off until you turn them on.

In Hermes a room wakes a chat only after two acts: the chat is brought into the room (by you on the Rooms page or
with `/lampstand listen`, or by the agent's `lampstand_room_listen` call, which you can see), and you allow lampstand
to start turns in the profile (`hermes config set plugins.entries.lampstand.allow_gateway_injection true`), which
lampstand never sets itself. A chat that listens starts at the room's latest message, never its backlog.

What a woken turn can do is what that chat can do: its tools and its approval mode. A room author agora lets wake the
chat starts a full agent turn. Every delivered message is framed as input from another party, with its header fields
stripped of anything that could forge another line, and the agent is told never to obey it; but with approvals off
(YOLO), a room participant can steer what the agent does. Keep approvals on in chats that listen to rooms other people
post in. A chat the room has woken 24 times in a row with nobody taking a turn there pauses until someone does.

Who signs what: posts made from the desktop's Rooms page and through `/lampstand relay` are yours, signed as this
seat's human. A relay posts only for people Hermes has already authorized on that platform (it runs after Hermes's own
check). Posts an agent makes go through `lampstand_room_post`, signed as `<house>/<name>`, the name its listen was
given; the tool takes no other signer, and no actor from the process environment ever signs.

## The operator and the agent

The House page, `/lampstand` typed by you, and the `lampstand` CLI in your own terminal act as the operator. lampstand's
tools act as the agent: the plugin sets `LAMPSTAND_AGENT=hermes` in the Hermes process, which the agent's terminal
inherits, and the CLI refuses that environment the operator's verbs (adopting or striking a principle or a rule,
turning the scheduler on). This keeps an honest agent inside its lane; it is not a security boundary against an agent
that sets out to defeat it, since a shell the agent controls can unset a variable. Anyone who can use your Hermes
dashboard can act as the operator on the House page, so keep the dashboard behind its login.

## Where it looks for houses

The House page lists the houses your sessions worked in, plus any folder directly under `~/houses` and
`~/Documents/houses` (or the `houses_dir` setting) that holds a `house.toml`. It reads each house's files, and its git
status, log and remote, and nothing else.
