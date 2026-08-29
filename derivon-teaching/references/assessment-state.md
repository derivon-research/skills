# Teaching Assessment State

Teaching leaves the graph, manifest, and object documents unchanged. A local
workspace has one writable Teaching artifact:

```text
<workspace>/.derivon/teaching/state.json
```

The file uses strict `derivon.teaching/v1` and stores concise assessment evidence,
not raw learner answers or account identity.

Resolve the installed Teaching skill directory as `SKILL_DIR`, then use:

```sh
node "$SKILL_DIR/scripts/assessment-state.mjs" start <workspace> \
  --target <point-id>
node "$SKILL_DIR/scripts/assessment-state.mjs" show <workspace>
node "$SKILL_DIR/scripts/assessment-state.mjs" record-round <workspace> \
  --expected-revision <sha256> --round-file <round.json>
node "$SKILL_DIR/scripts/assessment-state.mjs" reconcile <workspace> \
  --expected-revision <sha256>
node "$SKILL_DIR/scripts/assessment-state.mjs" close <workspace> \
  --expected-revision <sha256>
node "$SKILL_DIR/scripts/assessment-state.mjs" validate <workspace>
```

`show` and every successful write return the current revision. When state already
exists, `start` also requires `--expected-revision`. A revision mismatch refuses
the write; reread and reconcile instead of overwriting another local session.

## Round input

Pass one complete evaluated round as a JSON file:

```json
{
  "summary": "Target application round",
  "items": [
    {
      "pointId": "A",
      "status": "partial",
      "evidence": "Distinguished the main cases but missed the boundary condition.",
      "taskType": "boundary-analysis",
      "gap": "Does not yet test the zero case.",
      "basisObjectIds": ["A", "h-a-b"]
    }
  ],
  "frontierPointIds": ["B"]
}
```

Statuses are `demonstrated`, `partial`, or `not-demonstrated`. Evidence and gap
are concise Agent judgments grounded in the completed round. Do not put the
learner's response transcript in this file. `basisObjectIds` names the point,
hyperedge, and document objects used to make the judgment; the assessed point
itself is required.

The tool fingerprints each basis graph object and its complete owned document
directory. `reconcile` marks evidence and current concept status stale when a
basis changes or disappears. Stale history remains visible but cannot be treated
as current mastery evidence.

## Lifecycle

The workspace has at most one active assessment. Close it before starting a
different target set. Closing preserves assessments, rounds, and concept history.
Current concept status may move in either direction as new rounds append. Prior
status is diagnostic evidence, never an unquestioned query start.

The tool never modifies `.gitignore` and never commits state. Tell the user the
state path; the user decides whether to keep it private, synchronize it, or place
it under version control. Resetting history or deleting the state file is outside
the normal command surface and requires an explicit impact summary and user
confirmation.
