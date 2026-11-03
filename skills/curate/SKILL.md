---
name: curate
description: "Curating a house's normative text: when a principle, provision or reflex may be proposed, how it is admitted, revised and retired, and the budget each surface lives under. Use when you notice a lesson worth keeping, when a rule fired wrongly or failed to fire, when a surface nears its cap, or when the operator asks to add, change or drop a principle or rule. Not for recording ordinary work (the house skill)."
---

# Curate: principles, provisions and reflexes

The normative files are loaded into every session, so every line costs attention forever and a wrong line misleads
every session until someone removes it. Curation is conservative on entry and quick on exit.

## §0 Keeping this skill true

When a curation rule here proves wrong in use, rewrite it in the same change that records the case. The rules govern
their own curation: this file is held to the same admission, revision and retirement tests it describes.

## Who decides what

- **Principles and provisions** are the operator's. You may draft and propose them with an occasion; only the operator
  adopts (`lampstand adopt`). Never adopt on the operator's behalf and never recommend an item during an adopt: the one
  judged by a lens does not shape it.
- **Reflexes** are yours: learned habits that make you work better here. You admit, revise and retire them under the
  tests below, and the operator may review.

## Admission: a new reflex

Admit a reflex only after a real failure, never in anticipation. It must pass all four:

1. **A stable shape:** you can state the habit in one line.
2. **Value across sessions:** it applies beyond the one task where it was learned.
3. **It must load as reflex:** it fires mid-action, before you would think to search for it. If knowing to look it
   up is enough, it belongs in `knowledge/`, not in a loaded surface.
4. **Falsifiable:** it says what evidence would show it stale and what to do then.

Write it with `lampstand propose reflex <file> --occasion "<the failure that taught it>"`, then admit it.

## Admission: a principle or provision

A principle is safe to load as an unconditional lens only if applying it everywhere cannot cut a safety margin or
abandon an honest path. Each carries a failure mode (how it goes wrong by excess); a candidate without one is not
ready. A provision states its occasion, its reason and which principle it comes from.

## Revision and retirement

- **Revise in the same turn** a rule fires wrongly, or fails to fire when it should have. Deferring the fix is how
  loaded text rots.
- **Retire** a reflex that has not fired across several relevant sessions, one whose subject changed, or one a check or
  tool now enforces (replace it with one line naming the check).
- **Rewrite in place;** never add a correction beside an old claim. History lives in git.

## Budgets

Every loaded surface has a character cap (`.house/generated/manifest.json` shows sizes against caps). A surface over
its cap may not grow; shrinking always passes. A cap rises only by the operator's act, and never in the same commit
that grows the surface it caps. When a surface nears its cap, retire before you admit.

## Principles of the craft

- A rule kept true only by remembering to keep it true is already drifting. Prefer a check, a cap or a tool that owns
  the upkeep.
- A small rule set whose smallness matters is pinned by an exact-equality test, with a comment saying why it is small.
- A check reports only what is wrong on its own evidence. Anything that depends on intent is information, never an
  error.
