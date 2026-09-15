# Teaching Assessment Records

Teaching leaves the graph, manifest, and object documents unchanged. Its assessment
evidence lives where the application already keeps what a learner has reached: the
**learner record**, outside the workspace.

```text
<application data directory>/learner-records/<workspace id>/state.json
```

That file is `derivon.learning/v1`, specified by `derivon-mindmap`'s
[learner records](https://github.com/derivon-research/derivon-mindmap/blob/main/docs/learner-records.md).
Teaching does not define a protocol of its own and does not add a status axis: it writes
**judgements** into the one store the application reads, so a concept this skill assesses shows
up as mastery in the application like any other.

Read and write it through the command surface, which computes the path from the workspace `id`
itself:

```sh
CMD="node $SKILL_DIR/../derivon-mindmap/scripts/derivon-workspace.mjs"
WORKSPACE=/absolute/path/to/workspace

$CMD read-learner-record "$WORKSPACE" --file state
$CMD write-learner-record "$WORKSPACE" --file state \
  --expected-version <version> < state.json
```

Resolve `SKILL_DIR` to this skill's installed directory before running anything, and follow the
read-modify-write shape in the `derivon-mindmap` skill's `references/unix-recipes.md`.
`read-learner-record` returns the file verbatim plus the `version` a later write has to
carry; `present: false` with `version: null` means this learner has assessed nothing here yet,
which is not an error.

## One assessed concept

Teaching's verdicts are its own method vocabulary; the record has one status axis. The mapping
is fixed:

| Teaching verdict | Record |
| --- | --- |
| `demonstrated` | `status: "complete"` |
| `partial` | `status: "incomplete"` with non-empty `data` |
| `not-demonstrated` | `status: "incomplete"` with non-empty `data` |

```json
{
  "schema": "derivon.learning/v1",
  "concepts": {
    "limit-of-a-sequence": {
      "status": "incomplete",
      "basis": "<computed by the command>",
      "data": {
        "teaching": {
          "verdict": "partial",
          "taskType": "boundary-analysis",
          "gap": "Does not yet test the zero case.",
          "evidence": "Distinguished the main cases but missed the boundary condition."
        }
      }
    }
  },
  "derivations": {}
}
```

- **`basis` is left out and the command fills it in.** It covers the assessed object's manifest
  entry and every file under its document directory, and nothing else — so a change to some
  *other* object never retires this judgement. Do not compute a hash yourself and do not carry a
  second list of "basis objects": a judgement about one concept is retired by that concept's own
  content changing, and an object consulted while assessing it is context, not a freshness rule.
- **`evidence` and `gap` are concise judgements**, never the learner's response. The record is
  not a transcript, and a markdown report to the user is not a substitute for recording what the
  assessment concluded.
- **`data` is namespaced by its writer.** `teaching` is this skill's namespace. Never write
  `selfReported` (that is the learner's own claim, made through the application) and never write
  a record with no namespace as if the application had verified it — a judgement carries who
  made it.
- **`incomplete` must carry non-empty `data`.** *Asked, and not reached* has to say something
  about how it was reached; `partial` and `not-demonstrated` already differ in `verdict`.
- **Absence is not `incomplete`.** A concept with no record has not been assessed here; leave it
  out rather than writing a record that says so.
- A derivation can be assessed the same way, in `derivations`, with the same fields: concept and
  derivation mastery are isomorphic.

## The round is the session's, not the file's

- One round, one write. Compose the whole `state.json` from what you read, add or replace the
  records for the concepts this round assessed, and write it with the version you read.
- The **frontier**, the target set, and the round history are session state. Keep them in the
  conversation; do not invent keys in the record for them (the protocol refuses unknown keys,
  and a second store of *which concepts are assessed* is a second source of truth for mastery).
- A version that no longer matches refuses the whole write with `conflict-precondition` and
  changes nothing. Re-read, reapply your records, retry.
- Staleness is derived by the application from `basis`; the record is kept as evidence and never
  deleted as a side effect. Nothing in this skill deletes a record.

## Privacy

Learner records are not workspace content: they are absent from the manifest, from workspace
synchronization and from the workspace revision, so recording a round never changes a file
inside the workspace. Tell the user the record path and let them decide what to do with it.
Never modify `.gitignore`, never commit a record, and never delete or reset one without an
explicit impact summary and the user's confirmation.
