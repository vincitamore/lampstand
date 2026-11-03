# Contributing

Thank you for helping. A few things keep lampstand dependable; please read them before opening a pull request.

## Setup

```sh
git clone https://github.com/vincitamore/lampstand
cd lampstand
git checkout dev
npm ci
```

Work lands on `dev`. The default branch carries one built commit per release and moves only by the release script.

## Checks

Every pull request runs these; run them locally first:

```sh
npx tsc --noEmit -p .
node --test "test/**/*.test.js"
bun test test/
python -m unittest discover -s test
node dev/version-sync.js
```

The release gates run on every push to `dev`; run them before opening a pull request:

```sh
node dev/prose-gate.js && node dev/leak-gate.js && node dev/link-check.js && node dev/skills-validate.js
node dev/context-budget.js && node dev/disclosure-check.js
node dev/release.js --out <empty dir>
python dev/scan-gate.py <a Hermes install's venv python>   # or HERMES_PYTHON=...
```

`node --test` needs the glob: given a directory, Node loads it as a module instead of searching it. On Node older
than 22.18, add `--experimental-strip-types`: the OMP adapter's tests import its TypeScript source.

## Trying a change in a host

- **OMP:** load the extension from your checkout with `omp -e <checkout>/hosts/omp/index.ts`. `omp plugin install
  <checkout>` lists the plugin but does not load it: OMP links the folder without declaring it, then skips it as a
  stale entry.
- **Hermes:** commit your change, then `hermes plugins install file://<checkout> --ref <commit> --enable` into a
  throwaway `HERMES_HOME`.
- **The CLI:** `node core/bin/lampstand.js <verb>` from the checkout.

## Rules the code keeps

- **No runtime dependencies.** `package.json` has no `dependencies` key, and a test pins that. The TOML and
  frontmatter parsers are our own strict subsets.
- **Shipped code is `.js`, `.ts` and `.py`.** Hermes's install scanner reads those and skips `.mjs`, `.cjs` and
  `.tsx`, so we use none of them and every shipped file is scanned.
- **Python in `hosts/hermes/` uses the standard library only**, and `register()` does no subprocess, socket or
  network work.
- **The OMP extension registers no `tool_call`, `tool_result` or approval handler**; any of those turns off the
  host's speculative execution for every session.
- **No step reads `git status`.** Jobs land only the paths they declared, and the gate reads changes with
  `git diff` and `git ls-files`.
- **Tests write only to temporary directories.** Point the state and config roots at temp dirs
  (`LAMPSTAND_STATE_ROOT`, `LAMPSTAND_CONFIG_ROOT`) and never touch the real OS scheduler from a test.
- **A test pins an invariant, not an incidental value.** "At the current schema version", not "version 1".
- **Comments carry the technical why**, nothing else: no dates, no references outside this repository.

## The lattice

`packs/lattice/LATTICE.md` is shipped verbatim. Do not edit it in a pull request, and no tool may rewrite it. It is the
one file exempt from the prose gate's rules on symbols and dashes. Suggestions about its text are welcome as issues.

## Reporting security problems

See [SECURITY.md](SECURITY.md).
