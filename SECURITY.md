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
- **With your consent, one item at a time:** a `default_house` entry in per-user config, and one OS scheduler entry per
  house (a per-user scheduled task, systemd user timer, launchd agent or crontab line). Each is recorded in `seat.json`
  with what was there before; `lampstand seat reset` restores it.

lampstand never patches a host, never writes another plugin's files, never sets a theme or a global host setting, and
never writes a Hermes `SOUL.md`.

## What lampstand runs

- `git`, in the house only: `rev-parse`, `diff --name-only`, `ls-files --others`, and, for a job that commits, `add`
  and `commit` of exactly the paths the job declared and produced (then `show --name-only` to check them). It never
  runs `git status`, and never pushes unless a job is declared with `commit = "push"`.
- `node` (or Bun) running lampstand's own CLI.
- The commands you declare as jobs in `house.toml [jobs]`, and only when you run them or turn the scheduler on.
- `doctor` reads versions from `omp`, `agora` and `node` when those are installed.
- The OS scheduler tools (`schtasks`, `systemctl --user`, `launchctl` or `crontab`): they create or remove the tick
  entry only for `lampstand scheduler enable`, `disable` and `lampstand seat reset`; `doctor` and
  `lampstand scheduler` only query them.
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
