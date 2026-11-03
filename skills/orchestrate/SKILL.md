---
name: orchestrate
description: "Running a multi-agent research or design pipeline: designing the topology a question needs, dispatching parallel agents that each write a short handle and a full output, keeping a manifest with lampstand forge, and evaluating the synthesis instead of ratifying it. Use for open questions with three or more independent concerns, design decisions touching several systems, or comparisons where each option needs its own evidence. Skip single-file fixes, lookups and linear tasks; for driving an already-decided work list to done, use the campaign skill."
---

# Orchestrate: pipelines for questions with several faces

You are the orchestrator: the only party that sees the whole question, the operator's words, and every agent's result.
Design the pipeline the question needs; do not force it into a template.

## §0 Keeping this skill true

When a rule here fails in use (an agent misreads a convention, a check misses a failure it should catch), fix the rule
in the same change that records the failure, and state the current rule rather than its history.

## When to use it

Use a pipeline when the question has three or more concerns that different agents can investigate from different
sources, or when triangulating from independent angles would change the answer. One or two serial calls need no
pipeline: ask the agent directly. Fidelity, not economy, decides: if several angles would improve the answer, use them.

## The loop

1. **Name the concerns** as nouns ("prior art", "data availability", "failure modes"). Each becomes a first-layer
   agent when its sources are disjoint. Pick each agent's type by the tools it needs, and keep for yourself any concern
   that needs the conversation's context.
2. **Start the manifest before any agent runs:** `lampstand forge new "<title>" --body "<one-line goal>" --stages
   <layer names, comma-separated>`. Write the plan into it (each concern, its agent type, its handle and output
   paths). Anything a first-layer agent must not see (your own priors) stays out of the manifest, because agents read
   it while orienting.
3. **Dispatch in waves of five to seven.** Every brief carries the conventions below, its own handle and output paths,
   and the sources to read. Record each dispatch with `lampstand forge log <session> "<concern> | started | <id>"`.
   The agent's id is its only address for a later correction; record it.
4. **Read the full outputs** as they land, not only the handles. Tune the next wave's briefs from what misfired.
5. **Synthesize** with an agent whose job is integration: reconciling disagreements with evidence, not averaging
   them. Keep each synthesis to five to eight sources; above that, add an intermediate synthesis layer.
6. **Evaluate the synthesis; never ratify it.** For each claim an action will rest on, ask what tier of evidence it
   has: a direct read or run (trust), a reading of documentation or prose about state (check cheaply), or an argument
   (weigh it). Run the cheap check before acting.
7. **Reconcile the plan against the log:** every planned concern has a started and a completed entry and its files
   exist, or the log says why it was dropped.
8. **Distil:** reusable findings to `knowledge/`, concrete work to `tasks/`, decisions the operator owes to
   `inbox/decisions/` with the options costed. A decision that exists only in your closing message has not been
   captured.

## Conventions every agent receives

> You are one agent in a pipeline. Write two files. First a **handle**: a summary a reader can scan in a minute, with
> sections Key findings, Recommendations, Open questions, and the evidence tier of each load-bearing claim (measured,
> read in source, from documentation, inferred). Then the **full output**: your complete analysis, any length. Write
> the handle first so it survives if you run out of time. Your handle path is yours alone; never write another
> agent's. If a write is refused, put the whole artifact in your final message instead of working around the refusal.
> If you start a process, stop it by the id you started, never by name.

## Pitfalls

- **Two agents on one handle path** overwrite each other. One path per agent, always.
- **Agents do not inherit your conversation.** Put every fact they need in the brief; front-load what you verified.
- **A confident synthesis is not evidence.** Internal coherence comes free; the check that touches the state is what
  makes a claim true.
- **Agreement is not independence.** Several agents reading the same source agree because of the source. Weigh
  agreement by how independent the witnesses were.
- **An agent's claims about files it does not own are stale** by the time you read them. Verify against the tree.
- **A long job an agent starts can outlive the agent.** When a report says a run is still going, find its process and
  watch it yourself.
- **Commit pipeline outputs when the wave closes**, not while sibling agents are still writing into the same folder.
