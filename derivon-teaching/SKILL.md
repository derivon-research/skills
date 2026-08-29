---
name: derivon-teaching
description: Assess a user's understanding of target concepts through graph-grounded, non-leading grilling rounds. Use for quizzes, oral examinations, mastery checks, misconception diagnosis, prerequisite probing, or teaching assessment over an existing Derivon Mindmap. Read-only by default.
---

# Derivon Teaching

Use `derivon-cli` and `derivon-mindmap` with this skill. Assess understanding; do
not edit the graph or persist learner state unless the user explicitly requests a
separate artifact.

Map the assessment as a diagnostic tree. Graph prerequisites shape candidate
branches, but user answers decide which branches remain open.

## Establish the target

1. Read the target concept documents, relevant derivation documents, and their
   tails. Do not grade facts the graph does not contain; report coverage gaps.
2. Ask for target concepts and let the user name content they believe they know.
3. Start with a target-level discrimination, application, transfer, case, or
   scenario task. Do not begin by asking for verbatim definitions.
4. If the target is not demonstrated, expand backward through relevant
   hyperedges. Sample claimed known concepts instead of treating them as facts.

## Work in rounds

The frontier is the set of currently independent diagnostic questions whose
prerequisite decisions are settled. Select at most three questions with the
highest information value; queue the rest.

Format each round as numbered questions separated by horizontal rules. Do not
provide recommended answers, leading hints, conclusions to repeat, or answer
shapes before the user responds. Wait for the complete round.

After the response:

- mark each item `demonstrated`, `partial`, or `not demonstrated`;
- cite concrete evidence from the user's reasoning;
- explain the exact gap without treating unfamiliar wording as failure;
- retry with a different task type when needed;
- recompute the diagnostic frontier and relevant route.

A reply such as “I understand” or a copied definition is not mastery evidence.
At least one task must require use, comparison, prediction, boundary analysis, or
transfer beyond text just supplied by the Agent.

## Finish

Stop when the targets are demonstrated, the user stops, or graph/source coverage
prevents a defensible judgment. Return a conversation-local report:

- demonstrated concepts and evidence;
- partial concepts and exact gaps;
- not-yet-demonstrated concepts;
- graph coverage limitations;
- recommended next learning route or review tasks.

Do not write scores, progress, starts, or mastery flags into the shared graph.
