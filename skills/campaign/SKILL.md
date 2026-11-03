---
name: campaign
description: "Driving an already-decided work list to shipped with build agents: partitioning it into units that each own their files, writing self-contained briefs, dispatching in small waves, reviewing reports, routing fixes to the owning builder, and integrating behind mechanical gates. Use for three or more implementation, fix or migration units over a known list. Skip open questions about what to build (the orchestrate skill) and single bounded tasks (just do them or dispatch one agent)."
---

# Campaign: shipping a decided work list

The thinking about *what* is done; a campaign drives the *doing*. You hold the reins: the partition, the briefs, the
review and the integration. Builders pull.

## §0 Keeping this skill true

When a rule here fails in a real campaign, rewrite the rule in the same change that records what happened, stating
the current rule. A rule that only lives in your memory of the last campaign does not exist for the next one.

## The loop

1. **Scope.** Write the work list into a manifest (`lampstand forge new`). What is in this campaign and what is not is
   your call; finding the list can be delegated, cutting it cannot.
2. **Partition by file ownership.** Every unit names the files it owns and the files it must not touch. A change a
   unit needs outside its files goes in its report as a patch, never applied across the line.
3. **Own every shared seam yourself.** A file every unit would append to (a command registry, a migration list, a
   schema) belongs to you. Pre-stub it before the wave (give each unit its own registration file, assign every
   migration number), or apply the units' patches yourself at integration.
4. **Write the briefs.** One shared conventions block, then per unit: the task, owned and forbidden files, sources, the
   checks it must pass, its report path. Builders start blank: the brief is their whole context. Read the end of every
   brief before sending it; a brief cut off mid-sentence still dispatches cleanly.
5. **Dispatch small waves.** Two to five builders at once is plenty; wide fan-outs exhaust usage limits and stop every
   agent mid-edit together. Record each builder's id in the manifest the moment it starts.
6. **Review each report as it lands.** Read its claims about its own files; verify its claims about anything else
   against the tree, because its view froze at its last read. Run the checks yourself: a report saying "green" is a
   claim, a pasted command and its output is evidence, and your own run is the verdict.
7. **Route fixes to the owner** with the evidence, the hypothesis and the check that must pass. Start a fresh builder
   only when the owner is gone or the fix crosses ownership.
8. **Integrate.** Re-read the units' changes in pairs, not one by one: two correct units can compose into a defect
   neither could see (one adds text to a shared component, the other wraps that component in a context where the text
   is wrong). Then run the whole suite on the merged tree.
9. **Measure with a different instrument before calling it done.** A builder verifies with the tool it built with,
   which is blind in the same places. One final unit whose only job is to measure the whole, forbidden from fixing what
   it finds, is the difference between shipping and shipping something true.

## Rules builders must be told

- **Run checks in the foreground.** An agent cannot be woken by a background job finishing; a builder that ends its
  turn "waiting" has stopped, and its result is lost unless you run it yourself.
- **Write the report file first**, as a plan, and fill it in as parts land, so an interrupted builder leaves its state.
- **Stop processes by the id you started**, never by name.
- **No agents of their own.** A builder's sub-agents count against the same limits and report to no one.
- **Tests write only to temporary directories.** Check the machine's real state locations after a full suite run.

## When fix rounds keep producing new findings

If each round's new findings come from the last round's fixes, stop patching. Name the structure the special cases
are circling (one record per action, one predicate every path reads) and brief the redesign in one round, keeping
every earlier probe as a test.

## Pitfalls

- **A test that pins an incidental value** (a schema version number, an exact list of tables) breaks the next
  legitimate change. Pin invariants: "at the current version", "contains the tables this unit creates".
- **A mutant caught by a crash was not caught.** When checking that tests detect a planted defect, keep the defect's
  shape so it changes behaviour only; a thrown error is a survivor in disguise.
- **Fixing one instance of a defect class:** in the same breath, search for its siblings and dispatch or file each.
- **A unit that waits on outside state** (CI, a deploy) is not watching it. Read that state yourself and take over the
  wait.
