# Projects

This folder holds what the house builds: tools, libraries, experiments. Each project lives in its own folder,
`projects/<name>/`.

The house's records stay where they are. Tasks, decisions, knowledge and state live in their own folders and link to the
project they concern, so the record of a project never sits inside it.

A project that has its own git repository may live here as a nested repository. Name its folder in the house's
`.gitignore` so the house does not track it twice.

Git keeps no empty folder. This file is what makes `projects/` survive a clone.
