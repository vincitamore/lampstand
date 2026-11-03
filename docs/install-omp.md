# Install on OMP

lampstand needs OMP 18.3.2 or newer, Node 22.13 or newer (or Bun) and git.

```sh
omp plugin install "github:vincitamore/lampstand#v0.1.0"
npm install -g "github:vincitamore/lampstand#v0.1.0"
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
`lampstand upgrade` in the house to migrate it.

## Checking the install

`lampstand doctor` reports the OMP version, whether the extension is loaded twice (for example, installed as a plugin
and also listed under `extensions:` in your OMP config), and files in your own OMP folders that shadow the plugin's.

## What the plugin does in a session

- On start, it finds the house above the working folder and queues a short orientation (counts and any problems).
- Before each request, it adds the router to a main session and the worker to a subagent, once each.
- Before the session ends, it runs the maintenance gate.

Outside a house it does nothing beyond one line saying so.
