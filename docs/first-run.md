# First run

## Plant

```sh
lampstand init ~/my-house
```

`init` asks six questions, and explains each before asking it:

1. **Where** the house lives (the folder you named).
2. **Its name.**
3. **Who has care of it:** your name, and anyone who shares it.
4. **What the work is for:** one or two sentences, at most 600 characters. This opens every session's kernel, which
   also holds one line per principle and your ask-first lines in at most 4,000 characters; with the lattice that
   leaves about 460 characters for the purpose, and `init` asks again if the three do not fit.
5. **How rules are made:** `none`, `rules` (you enact, the agent drafts) or `agreement` (a written agreement between
   you and the agent).
6. **What always needs asking first,** and how the agent should speak on each channel you use.

It then plants the house, starts a git repository if there is none, compiles what your agent will load, and commits
exactly what it planted as one commit, `Plant the house`; anything else you had staged stays out of it. If git has no
name and email to sign with, the files stay uncommitted and `init` prints the command to commit them once you have set
those. Planting writes only missing files: run it again any time.

To plant without questions, write the answers to a file and pass `--answers answers.toml`. To start with no
principles, add `--no-lattice`.

## Look around

```sh
cd ~/my-house
lampstand status
lampstand compile --check
lampstand doctor
```

`compile` prints each loaded surface's size against its cap. `doctor` exits 0 when the house and its hosts are healthy,
and names the fix for anything that is not.

## Make it yours

- Read `principles/lattice.md`. Edit any principle, or delete one that does not fit. Run `lampstand compile` after.
- Read `charter/core.md`, and `voice.md`.
- Add a task: `lampstand task new "First thing to do"`.

## Adopt

When the agent proposes a principle, a rule or an updated pack, it waits in `proposals/`. Run `lampstand adopt` to see
each one verbatim with its size; adopt, edit, strike, or leave it for later. What a run adopts or strikes (the record in
`charter/record.md`, the moved proposal, the recompiled projections) is committed in one commit, `Adopt <kind>/<slug>`
or `Strike <kind>/<slug>`, naming each item; when every item is left for later, nothing is committed.

## Turn things on

Nothing runs on its own until you turn it on:

- **Jobs:** declare them in `house.toml [jobs]`, set `[modules] scheduler = true`, then `lampstand scheduler enable`
  lists the one OS entry it will create and asks before creating it.
- **Rooms:** install agora, set `[modules] rooms = true`, then `lampstand rooms enable`.
