# Install on Hermes

lampstand needs Hermes 0.22.6 or newer, Node 22.13 or newer and git.

```sh
hermes plugins install vincitamore/lampstand
npm install -g "github:vincitamore/lampstand#v0.1.0"
```

Hermes scans the plugin, then asks two questions:

- **"lampstand declares Node dependencies (package.json). Install them into the plugin's own node_modules now?"**
  Hermes asks this of any plugin with a `package.json`. lampstand has no dependencies, so answer no; nothing is lost.
- **Whether to enable it.** Say yes.

The second command puts the `lampstand` command on your PATH.

The install follows the repository's default branch, which carries exactly the latest release. To pin one release,
pass its commit: `hermes plugins install vincitamore/lampstand --ref <commit>` (the full 40-character hash, listed on
the release page). In a Hermes identifier `#` names a subdirectory, not a tag.

Then plant a house and open a session in it:

```sh
lampstand init ~/my-house
cd ~/my-house
hermes
```

## Upgrading

`hermes plugins update lampstand` brings the plugin to the latest release; your house is untouched. Then run
`lampstand upgrade` in the house to migrate it; it commits exactly what it changed, as
`Upgrade the house to lampstand <version>`.

## What the plugin does in a session

- A prompt section named `lampstand-kernel` carries your kernel. When the house's `AGENTS.md` is the context file
  Hermes loads for the session, the section shrinks to a pointer, so the kernel is never loaded twice.
- On the first turn, it adds a short orientation.
- The `lampstand_delegate` tool starts a subagent with one of the house's agent roles and the worker projection.
- Before Hermes verifies a turn, it runs the maintenance gate.

Messaging surfaces and scheduled jobs have no working folder, so they use the house recorded with
`lampstand init --default`, and nothing else.

## Windows

On Windows the CLI is the `lampstand.cmd` shim, and Node and Bun refuse some characters (quotes, parentheses, `%`) in
a batch file's arguments: a long `--body "..."` can fail with `batch file arguments are invalid`. Pass the text on
stdin instead: `--body -`, or `lampstand capture -`.
