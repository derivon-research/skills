---
name: derivon-teaching
description: Assess a learner's understanding of target concepts through graph-grounded, non-leading grilling rounds. Use for quizzes, oral examinations, mastery checks, misconception diagnosis, prerequisite probing, or teaching assessment over an existing Derivon Mindmap. Keeps the graph and documents read-only while persisting assessment evidence as learner-record judgements between sessions.
---

# Derivon Teaching

Use `derivon-cli` and `derivon-mindmap` with this skill. Keep the graph,
manifest, and object documents read-only: assessment changes no workspace file.
Persist judgements through [the assessment-record contract](references/assessment-records.md),
which writes the learner record the application already reads.

Map the assessment as a diagnostic tree. Graph prerequisites shape candidate
branches, but learner answers decide which branches remain open.

## Establish or resume the learner

1. Read the target concept documents, relevant derivation documents, and their
   tails. Do not grade facts the graph does not contain; report coverage gaps.
2. Ask for target concepts and content the learner believes they know.
3. Read the learner record with `read-learner-record`: mastery records are this
   learner's current status, and each record's `data` says who made the judgement
   and on what evidence. Treat prior statuses as diagnostic evidence, not facts;
   sample route-critical claimed starts. An absent record means nothing has been
   assessed here, which is not the same as a record that says so.
4. Fix the target set for this session. There is no persisted active assessment:
   the target set, the frontier and the round history are session state.
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
- record the whole evaluated round as **one** `write-learner-record` call under
  the version you read, mapping each verdict to the record's one status axis and
  leaving `basis` for the command to compute.

A reply such as "I understand" or a copied definition is not mastery evidence.
At least one task must require use, comparison, prediction, boundary analysis, or
transfer beyond text just supplied by the Agent. Current status may move in either
direction; a later judgement replaces an earlier one, and the learner's own claims
are theirs, not yours to overwrite with anything but a judgement.

A judgement whose `basis` no longer matches the object's current content is stale.
The application derives that; never re-decide it here, never delete the record, and
treat stale evidence as historical until the learner is verified again.

Never copy assessment status into point/hyperedge data, starts, object documents,
or any other file in the workspace.

## Finish

Stop when the targets are demonstrated, the learner stops, or graph/source
coverage prevents a defensible judgment. Record the final round's judgements,
report the round as complete, and return:

- demonstrated concepts and evidence;
- partial concepts and exact gaps;
- not-yet-demonstrated concepts;
- stale evidence that needs revalidation;
- graph coverage limitations;
- recommended next route or review tasks;
- the learner-record path and its privacy/version-control boundary.

Do not modify `.gitignore`, commit a learner record, delete history, or reset the
record without explicit authorization.
