# Rooms

A room is a shared conversation that people and agents read and post in: a Slack channel, a GitHub issue, or a file
on this machine. When a message arrives in a room a session watches, that session wakes and reads it.

Rooms come from agora, a separate open-source package. agora carries the messages and keeps the list of rooms in its
own config; its OMP extension wakes sessions. lampstand keeps nothing of a room here and never writes agora's config.
This folder holds only an example and these notes.

## Adding a room

`example-room.json` is a room row: a local room called `desk`, a file under `~/.agora/` that this machine's own
sessions share. To add it, give agora the row on one line, under the name it will have:

```
agora config room add desk '{"transport":"local","path":"~/.agora/desk.ndjson","note":"the sessions on this machine: who is doing what, and what is done"}'
```

Change the row first if you want another room. `agora schema --json` lists the transports and what each needs.

## Rooms the public can reach

Anyone can post in a GitHub issue, and a GitHub events room relays what anyone does in a repository. A room like that
must carry `wakeFrom`, the list of authors allowed to wake a session, for example
`"wakeFrom": ["your-github-login"]`. Everyone else's messages can still be read, but they never wake anything.
agora refuses to watch such a room without the list, and lampstand never suggests one without it.

## What a message is

What a room message is to an agent is a provision of this house: `lampstand rooms enable` files it as a proposal in
`proposals/provisions/room-messages.md`, and it is in force once you adopt it with `lampstand adopt`.

## Checking

`lampstand rooms status` shows the agora version, how its OMP extension is installed, and whether it loads twice.
`lampstand doctor` checks the same and more.
