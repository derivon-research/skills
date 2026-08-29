---
name: derivon-teaching
description: Assess a learner's understanding of target concepts through graph-grounded, non-leading grilling rounds. Use for quizzes, oral examinations, mastery checks, misconception diagnosis, prerequisite probing, or teaching assessment over an existing Derivon Mindmap. Keeps the graph and documents read-only while persisting learner assessment evidence between sessions.
---

# Derivon Teaching

Use `derivon-cli` and `derivon-mindmap` with this skill. Keep the graph,
manifest, and object documents read-only. Persist only learner assessment state
through [the assessment-state protocol](references/assessment-state.md).

Map the assessment as a diagnostic tree. Graph prerequisites shape candidate
branches, but learner answers decide which branches remain open.

## Establish or resume the learner

1. Read the target concept documents, relevant derivation documents, and their
   tails. Do not grade facts the graph does not contain; report coverage gaps.
2. Ask for target concepts and content the learner believes they know.
3. Load and reconcile the workspace's single local Teaching state. Treat prior
   statuses as diagnostic evidence, not facts; sample route-critical claimed
   starts.
4. Start one active assessment for the target set. Close or explicitly continue an
   existing active assessment before changing targets.
5. Begin with target-level discrimination, application, transfer, case, or
   scenario work. Do not begin with verbatim definitions.

## Work in rounds

The frontier is the set of currently independent diagnostic questions whose
prerequisite decisions are settled. Select at most three questions with the
highest information value; queue the rest.

Format each round as numbered questions separated by horizontal rules. Do not
provide recommended answers, leading hints, conclusions to repeat, or answer
shapes before the learner responds. Wait for the complete round.

After the response:

- mark each assessed point `demonstrated`, `partial`, or `not-demonstrated`;
- cite concise concrete evidence from the learner's reasoning without storing the
  raw response;
- explain the exact gap without treating unfamiliar wording as failure;
- retry with a different task type when needed;
- recompute the diagnostic frontier and relevant route;
- record the complete evaluated round atomically with its basis object IDs and
  expected state revision.

A reply such as "I understand" or a copied definition is not mastery evidence.
At least one task must require use, comparison, prediction, boundary analysis, or
transfer beyond text just supplied by the Agent. Current status may move in either
direction; preserve prior rounds rather than overwriting their evidence.

If the graph object or document basis changes, reconcile fingerprints and treat
stale evidence as historical until the learner is verified again. Never copy
assessment status into point/hyperedge data, starts, replacements, or object
documents.

## Finish

Stop when the targets are demonstrated, the learner stops, or graph/source
coverage prevents a defensible judgment. Record the final complete round, close
the active assessment when appropriate, and return:

- demonstrated concepts and evidence;
- partial concepts and exact gaps;
- not-yet-demonstrated concepts;
- stale evidence that needs revalidation;
- graph coverage limitations;
- recommended next route or review tasks;
- the assessment state path and its privacy/version-control boundary.

Do not modify `.gitignore`, commit Teaching state, delete history, or reset the
state file without explicit authorization.
