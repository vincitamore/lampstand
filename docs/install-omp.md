# Install on OMP

lampstand needs OMP 18.3.2 or newer, Node 22.13 or newer (or Bun) and git.

```sh
omp plugin install "github:vincitamore/lampstand#v0.3.0"
npm install -g "github:vincitamore/lampstand#v0.3.0"
```

The first command installs the plugin: the extension that loads your house into each session, the skills and the
agents. The second puts the `lampstand` command on your PATH. Inside a session the same verbs are available as
`/lampstand status`, `/lampstand compile`, `/lampstand adopt` and `/lampstand doctor`.

Then plant a house and open a session in it:

```sh
lampstand init ~/my-house
cd ~/my-house
omp
```

## Upgrading

Install the new tag the same way; OMP replaces the plugin and keeps your house untouched. Then run
`lampstand upgrade` in the house to migrate it; it commits exactly what it changed, as
`Upgrade the house to lampstand <version>`.

## Things to know

- **The plugin loads in every OMP session.** `omp plugin install --scope project` is ignored for GitHub installs (OMP
  supports scope for marketplace installs only), so a GitHub install is global. Outside a house the plugin loads and
  says nothing.
- **Your own agents and skills win.** If you keep agents or skills named like lampstand's (architect, builder, and so
  on) in your OMP folders, yours take precedence over the plugin's, and `lampstand doctor` reports each as
  `OMP_SHADOWED`.
- **A shell that runs inside OMP carries the agent marker.** The plugin sets `LAMPSTAND_AGENT` in OMP's environment, so
  a terminal you open from inside an OMP session is treated as the agent's: `lampstand adopt` of a principle or
  provision, and `scheduler enable|disable`, are refused there with `E_OPERATOR_ONLY`. Run them from a terminal outside
  OMP, or adopt with `/lampstand adopt` in the session.

## Checking the install

`lampstand doctor` reports the OMP version, whether the extension is loaded twice (for example, installed as a plugin
and also listed under `extensions:` in your OMP config), and files in your own OMP folders that shadow the plugin's.

## What the plugin does in a session

- On start, it finds the house above the working folder and queues a short orientation (counts and any problems).
- Before each request, it adds the router to a main session and the worker to a subagent, once each.
- Before the session ends, it runs the maintenance gate.

Outside a house it does nothing and says nothing; `/lampstand status` reports that there is no house there.

## Windows

On Windows the CLI is the `lampstand.cmd` shim, and Node and Bun refuse some characters (quotes, parentheses, `%`) in
a batch file's arguments: a long `--body "..."` can fail with `batch file arguments are invalid`. Pass the text on
stdin instead: `--body -`, or `lampstand capture -`.
