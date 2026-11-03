---
name: skill-authoring
description: "Writing or revising a skill (a SKILL.md an agent loads on demand): the description that decides when it loads, the maintenance section that keeps it true, what belongs in it and what belongs in knowledge notes, and the checks to run before it ships. Use when creating a new skill, when an existing skill misfired, or when a tool a skill documents changed. Not for loaded principles and reflexes (the curate skill)."
---

# Writing skills

A skill is read when its description matches the task. A wrong description means it never loads, or loads where it
misleads; a stale body is worse than no skill at all.

## §0 Keeping this skill true

When a skill written by these rules still misfires, find which rule let it through and rewrite that rule in the same
change that fixes the skill.

## The description

One paragraph, under 1,024 characters, in three parts:

- **What it is for**, in the words a user would use for the task.
- **When to use it:** the concrete situations, phrased so a matching request is obvious.
- **When not to use it,** naming the sibling skill that covers the neighbouring case. A skill without a skip clause
  loads on every task that sounds near it.

## The body

- **§0 first:** a short section saying which changes in the world require changing this file, and that the change
  lands in the same commit as the fact. Every skill has one.
- **State standing reality:** the commands, contracts, conventions and pitfalls that stay true. Campaign state,
  progress and dates belong in task files, not in a skill.
- **Every pitfall carries its cause and its fix.** "X fails" is a warning; "X fails because Y; do Z" is usable.
- **Name what exists.** Every command, flag and path in a skill is one you have run or read in the source. A skill
  that names a flag the tool does not have teaches the next reader to distrust the whole file.
- **Keep it under 500 lines.** Long mechanism write-ups go in a knowledge note the skill links to.
- **Plain words for anything a user types or configures.** Proper names are fine for products; nothing a reader must
  look up to follow an instruction.

## Before it ships

1. Run every command it names, once, the way it is written.
2. Read the description against three requests it should catch and two it should not.
3. Check links resolve and the frontmatter parses (`name` and `description` only, unless the host documents more).
4. If the skill describes a tool, put the skill and the tool change in the same commit.
