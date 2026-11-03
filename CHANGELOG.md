# Changelog

## Unreleased

Found by running a house day to day with a live model.

- The maintenance gate charges a session only for what it changed. Work an earlier session left uncommitted was
  owed again by every session after it.
- `lampstand init`, `adopt`, `upgrade` and `rooms enable` commit what they wrote, touching only those paths. When git
  cannot commit, the files stay as written and the command to commit is printed.
- Filing a proposal or admitting a reflex no longer owes a task and a state note at the end of a session.
- Editing `[jobs]`, `[modules]` or `[gate]` in `house.toml` no longer marks the projections stale. The input hash
  changes once for every house; `lampstand upgrade` recompiles.
- `lampstand <group> --help` lists the group's subcommands, and items can be named by their title.
- `propose` finalizes a draft already in its proposals folder.
- `run --help` shows how to declare a job.
- Principles and provisions are adopted by the operator: `adopt` refuses them from an agent's shell, which each host
  adapter marks with `LAMPSTAND_AGENT`. Reflexes stay the agent's to admit.
- The house skill tells the agent to commit its work as it lands; two houses run with live models left a whole
  session's work uncommitted without it. A provision about commits overrides the default.
- Outside a house the plugin is silent. Installed for every session, it used to print a line in each one.
- `propose --help` shows an example file for each kind, and `propose` checks the file name before anything else.
- `--body -` reads the body from standard input, so Markdown never passes through shell quoting.
- The planted `.gitattributes` covers `.gitattributes` and `.gitignore`.
- `doctor` looks for a project `.omp` the way OMP does, stopping at the home and temp directories.

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
