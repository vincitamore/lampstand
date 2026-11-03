---
name: distill
description: "Turning what a session or pipeline learned into durable house knowledge: deciding what is worth keeping, where it goes (knowledge, a task, a decision, a reflex proposal), and writing it so a later reader can use it without the session that produced it. Use after substantive work, at the end of a pipeline, or when the maintenance gate says a lesson is owed. Not for curating loaded rules (the curate skill)."
---

# Distill: keeping what was learned

Work done in a session is lost when the session ends unless it lands in a file a later session reads. Distilling is
choosing what lands and writing it for that later reader.

## §0 Keeping this skill true

When a distillation habit here proves wrong (an article nobody could use, a lesson filed where it was never found),
rewrite the habit in the same change that records the case.

## What goes where

| You learned | It goes to | With |
|---|---|---|
| A pattern that will apply again (a mechanism, a pitfall with its cause, a method that worked) | `knowledge/<topic>.md` via `lampstand knowledge new` | the evidence and where it was observed |
| Work still to do | `tasks/` via `lampstand task new` | what done means |
| A choice the operator must make | `inbox/decisions/` via `lampstand decide new` | the options, each with its cost, and your recommendation |
| A bug to look into | `inbox/investigations/` via `lampstand inbox new investigation` | how to reproduce it |
| A habit that must fire mid-action | a reflex proposal (the curate skill) | the failure that taught it |
| A change to standing reality | `state/current.md` | one line, replacing the line it supersedes |

## Writing for the reader who was not there

- **Lead with the rule or the finding**, then the evidence. A reader skimming the first line should get the point.
- **Name the evidence tier:** measured, read in source, read in documentation, or inferred. A claim from prose about
  state is not a measurement of the state.
- **Cut every sentence whose subject is the work itself** ("this session", "we then tried"). Keep what is true of the
  world.
- **State the current truth, not its history.** When a finding replaces an old one, rewrite the old one; git keeps
  the history.
- **Link it:** every note links at least one related note, task or decision, so it is found from where it matters.

## Before you write

Search `knowledge/` first. A note that already covers the pattern gets updated, not duplicated. Two notes saying
nearly the same thing will drift apart, and a reader will find the stale one.
