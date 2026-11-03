# Changelog

## 0.2.1

An update that `lampstand upgrade` cannot apply for you now has a way to be taken or declined.

- `lampstand adopt` lists each update proposal (`proposals/updates/**`, written by `upgrade` when a planted file or the
  lattice pack changed and your copy must not be replaced) as `update/<path>`, for example `update/principles/lattice.md`,
  with its text verbatim and its size. Adopting writes the proposed text over the file (a principle file keeps its
  `origin` and is dated today, as principle adoption does), deletes the proposal, records the act in `charter/record.md`,
  recompiles and commits. Striking declines it and records the strike, so `upgrade` does not offer the same text again.
  `--ids update/<path>` does it without asking. An update replaces a planted file, so it is the operator's: an agent's
  shell is refused with `E_OPERATOR_ONLY`. If the file changed after the proposal was written, adopt refuses to overwrite
  it; a proposal written by 0.2.0 records no such hash and can be adopted only for the lattice while its copy is as adopted.
- The lattice proposal says what is true: the house's lattice is the operator's adopted copy and is never replaced, and
  upgrade lists it apart from the edited files it left alone.
- Houses upgraded under 0.2.0 hold an older proposal: run `lampstand upgrade` again to get the lattice's in the new form,
  then `lampstand adopt`.

## 0.2.0

Found by running houses day to day with live models. After upgrading the plugin and the CLI, run `lampstand upgrade`
in each house: the projections' input hash changes once, and the lattice's new text arrives as an update proposal.

Safety and authority:

- `lampstand init` plants a default ask-first list (irreversible deletes, history rewrites, publishing or pushing to
  a remote, spending money, messaging people outside the house, sending secrets or private data away, changing live
  systems) before the operator's own lines. Interactive init asks `Keep these? [Y/n]`; an answers file takes
  `ask_first_defaults = false` to plant only its own lines. Houses planted before keep their list: copy the lines
  listed in `docs/first-run.md` into `[charter] ask_first` and run `lampstand compile`.
- Principles and provisions are adopted by the operator: `adopt` refuses them from an agent's shell, which each host
  adapter marks with `LAMPSTAND_AGENT`. Reflexes stay the agent's to admit. `scheduler enable` and `disable` are
  the operator's too.
- With rooms on, a house's posts are signed with the house's name (`AGORA_ACTOR`, unless one is set), not the
  seat's default actor; `rooms status` reports the bearer.

Commits and the gate:

- `lampstand init`, `adopt`, `upgrade` and `rooms enable` commit what they wrote, touching only those paths. When git
  cannot commit, the files stay as written and the command to commit is printed.
- The house skill tells the agent to commit its work as it lands. A provision about commits overrides the default.
- The maintenance gate charges a session only for what it changed; work an earlier session left uncommitted was
  owed again by every session after it. Filing a proposal or admitting a reflex owes no task or state note. In
  block mode the owed list is printed once.
- Editing `[jobs]`, `[modules]` or `[gate]` in `house.toml` no longer marks the projections stale.

The kernel:

- A principle may carry a short `*Kernel:*` line, which the kernel loads in place of its thesis; the lattice pack
  ships one per glyph. A fresh lattice house's kernel drops from about 3,800 to 2,250 characters, leaving room for
  the operator's own principles and a full purpose. A house planted before receives the new lattice text as an
  update proposal, never an overwrite.

Using it:

- Outside a house the plugin is silent; installed for every session, it used to print a line in each one.
- `propose --help` shows an example file for each kind, `run --help` shows how to declare a job, and
  `lampstand <group> --help` lists a group's subcommands.
- `--body -` reads the body from standard input, so Markdown never passes through shell quoting (on Windows the
  `lampstand.cmd` shim refuses many quotes and parentheses in arguments).
- Items can be named by their title; a near miss suggests the closest slugs. Slugs end at a word boundary.
- `dropped`, `withdrawn` and `abandoned` items close with a plain reason; statuses that mean the work landed still
  need a link.
- `propose` finalizes a draft already in its proposals folder and checks the file name before anything else.
- In a `none` house the planted charter says there is none yet and how to start one.

Fixes:

- Two processes opening a new state database at once could see `database is locked`; the open now retries.
- `doctor` looks for a project `.omp` the way OMP does, stopping at the home and temp directories.
- The planted `.gitattributes` covers `.gitattributes` and `.gitignore`.

## 0.1.0

The first release. Tested on fresh installs on Windows and Linux with OMP 18.12 and Hermes 0.22.6; macOS is
untested so far.

- A house: a git repository with `house.toml`, the principles, the charter, reflexes, voice and state, and the work
  (tasks, decisions, investigations, ideas, captures, knowledge, reminders) as Markdown with frontmatter.
- `lampstand init`, `upgrade` and `seat`: plant a house from six questions, migrate it, and record every write made
  outside it so it can be undone.
- `lampstand compile`: the kernel, router, worker and watchdog projections, with character budgets and a ratchet.
- `lampstand adopt` and `propose`: principles, provisions and reflexes enter only by the operator's adoption.
- The OMP plugin and the Hermes plugin, from one repository: orientation, the projections, and the maintenance gate.
- Jobs and the scheduler: declared outputs, verified commits, one OS entry per house, silent unless a job did not land.
- `lampstand doctor`: objective checks with stable codes across the house, its state, OMP, Hermes and rooms.
- `lampstand rooms`, `rooms enable` and `rooms status`: rooms from agora 0.2.5 or later, an example room row, the
  rooms provision proposed for adoption, and how OMP loads agora's extension.
- Skills and agents for both hosts, and the lattice pack (CC0).
