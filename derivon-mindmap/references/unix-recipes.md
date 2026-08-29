# Unix Workspace Recipes

These recipes assume POSIX shell, `jq`, `derivon`, Node.js, and:

```sh
ROOT=/absolute/path/to/workspace
MANIFEST="$ROOT/.derivon/workspace.json"
SKILL_DIR=/absolute/path/to/installed/derivon-mindmap
node "$SKILL_DIR/scripts/validate-workspace.mjs" "$ROOT"
```

Resolve `SKILL_DIR` from the loaded skill location. Do not guess which Agent
installation directory was used.

## Inspect without mutation

```sh
jq '.graph' "$MANIFEST" | derivon validate --pretty
jq '.graph' "$MANIFEST" | derivon point list --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge list --pretty
jq '.graph' "$MANIFEST" | derivon query closure --start concept-a --pretty
jq '.graph' "$MANIFEST" | derivon query route \
  --start concept-a --target concept-z --pretty
jq '.graph' "$MANIFEST" | derivon query diagnose \
  --start concept-a --target concept-z --pretty
jq '.graph' "$MANIFEST" | derivon subgraph induced \
  --point concept-a --point concept-b --pretty
jq '.graph' "$MANIFEST" | derivon subgraph reachable \
  --start concept-a --pretty
jq '.graph' "$MANIFEST" | derivon subgraph route \
  --start concept-a --target concept-z --pretty
```

Query output is not a manifest. `subgraph` output is an envelope containing
`.graph` and `.selection`.

## Atomic graph mutation skeleton

Never redirect output onto `workspace.json`. Stage files in `.derivon` so the
final `mv` is on the same filesystem:

```sh
GRAPH_TMP=$(mktemp "$ROOT/.derivon/graph.XXXXXX")
NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX")
trap 'rm -f "$GRAPH_TMP" "$NEXT"' EXIT HUP INT TERM

jq '.graph' "$MANIFEST" \
  | derivon hyperedge set weight h-a-b 2.5 \
  > "$GRAPH_TMP"

derivon --input "$GRAPH_TMP" validate >/dev/null
jq --slurpfile graph "$GRAPH_TMP" '.graph = $graph[0]' \
  "$MANIFEST" > "$NEXT"
node "$SKILL_DIR/scripts/validate-workspace.mjs" \
  --manifest "$NEXT" "$ROOT"
mv "$NEXT" "$MANIFEST"
trap - EXIT HUP INT TERM
rm -f "$GRAPH_TMP"
```

This preserves `schema`, document metadata, and `view`. Substitute one CLI
mutation below for `hyperedge set weight`:

```sh
derivon point rename OLD NEW
derivon point data set ID /label --value '"New label"'
derivon point remove ID
derivon point remove ID --cascade
derivon hyperedge set tails EDGE --tail A --tail B
derivon hyperedge set head EDGE C
derivon hyperedge data set EDGE /source --value '"chapter 3"'
derivon hyperedge remove EDGE
```

Before rename/remove/cascade/rewiring, inspect incident edges, replacements, and
owned documents; report impact and obtain confirmation. Removing a graph object
does not delete its document directory.

## Add a concept with its document

Choose one atomic concept, a unique ASCII ID, and an unused directory. Coordination
such as Chinese `与`, `和`, `、` or English `and` requires an explicit atomicity
review.

```sh
ID=limit
DOC=docs/concept-limit
mkdir -p "$ROOT/$DOC"
printf '%s\n' '# Limit' '' 'Source-grounded definition, scope, and example.' \
  > "$ROOT/$DOC/document.md"
printf '%s\n' '<!doctype html><html><body>pending render</body></html>' \
  > "$ROOT/$DOC/index.html"

GRAPH_TMP=$(mktemp "$ROOT/.derivon/graph.XXXXXX")
NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX")
trap 'rm -f "$GRAPH_TMP" "$NEXT"' EXIT HUP INT TERM

jq '.graph' "$MANIFEST" \
  | derivon point add "$ID" \
      --data "{\"label\":\"Limit\",\"document\":\"$DOC\",\"format\":\"markdown\"}" \
  > "$GRAPH_TMP"
jq --slurpfile graph "$GRAPH_TMP" '.graph = $graph[0]' \
  "$MANIFEST" > "$NEXT"
node "$SKILL_DIR/scripts/render-documents.mjs" \
  --manifest "$NEXT" --write "$ROOT" "$ID"
node "$SKILL_DIR/scripts/validate-workspace.mjs" \
  --manifest "$NEXT" "$ROOT"
mv "$NEXT" "$MANIFEST"
trap - EXIT HUP INT TERM
rm -f "$GRAPH_TMP"
```

If candidate validation fails, keep the original manifest. Remove only the new,
confirmed-unowned directory when cleaning up; never delete an unknown directory.

## Add one genuine derivation

Read every tail, the proposed derivation source, and the head. All tails must be
jointly used. Distinct arguments become parallel hyperedges, not one merged tail
set.

```sh
ID=limit-sum
DOC=docs/derivation-limit-sum
mkdir -p "$ROOT/$DOC"
printf '%s\n' '# Sum rule for limits' '' \
  'Explain how every premise contributes and what step establishes the head.' \
  > "$ROOT/$DOC/document.md"
printf '%s\n' '<!doctype html><html><body>pending render</body></html>' \
  > "$ROOT/$DOC/index.html"

GRAPH_TMP=$(mktemp "$ROOT/.derivon/graph.XXXXXX")
NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX")
trap 'rm -f "$GRAPH_TMP" "$NEXT"' EXIT HUP INT TERM

jq '.graph' "$MANIFEST" \
  | derivon hyperedge add "$ID" \
      --tail limit-f --tail limit-g --head limit-sum-result --weight 2.0 \
      --data "{\"document\":\"$DOC\",\"format\":\"markdown\"}" \
  > "$GRAPH_TMP"
jq --slurpfile graph "$GRAPH_TMP" '.graph = $graph[0]' \
  "$MANIFEST" > "$NEXT"
node "$SKILL_DIR/scripts/render-documents.mjs" \
  --manifest "$NEXT" --write "$ROOT" "$ID"
node "$SKILL_DIR/scripts/validate-workspace.mjs" \
  --manifest "$NEXT" "$ROOT"
mv "$NEXT" "$MANIFEST"
trap - EXIT HUP INT TERM
rm -f "$GRAPH_TMP"
```

Omit every `--tail` only for a real unconditional step. It is not the learner's
known start set.

## Apply a related batch

Write typed operations to a temporary file. Every intermediate operation must
leave a valid core graph:

```sh
OPS=$(mktemp "$ROOT/.derivon/operations.XXXXXX")
cat > "$OPS" <<'JSON'
[
  {"op":"point.add","id":"B","data":{"label":"B","document":"docs/b","format":"markdown"}},
  {"op":"hyperedge.add","id":"h-a-b","tails":["A"],"head":"B","weight":1.5,"data":{"document":"docs/h-a-b","format":"markdown"}}
]
JSON

# Use the atomic graph mutation skeleton with:
jq '.graph' "$MANIFEST" | derivon apply --operations "$OPS" > "$GRAPH_TMP"
```

Create required object files, render against the candidate manifest, validate,
and atomically move only after the complete batch succeeds.

## Replacement projection

Replacement is view state. It never reaches `derivon` and does not assert
semantic equivalence.

Create a candidate replacement:

```sh
NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX")
jq '.view.replacements += [{
  points: ["A", "B"],
  replaceWith: "AB",
  show: "points"
}]' "$MANIFEST" > "$NEXT"
node "$SKILL_DIR/scripts/validate-workspace.mjs" --manifest "$NEXT" "$ROOT"
mv "$NEXT" "$MANIFEST"
```

Switch the persisted side:

```sh
jq '(.view.replacements[] | select(.replaceWith == "AB") | .show) = "replacement"' \
  "$MANIFEST" > "$NEXT"
```

Remove one relation:

```sh
jq '.view.replacements |= map(select(.replaceWith != "AB"))' \
  "$MANIFEST" > "$NEXT"
```

For every candidate, run the full validator before `mv`; it checks duplicate
members, target conflicts, and cycles.

## Render and validate

```sh
node "$SKILL_DIR/scripts/render-documents.mjs" "$ROOT"                 # drift check
node "$SKILL_DIR/scripts/render-documents.mjs" --write "$ROOT" ID      # publish selection
node "$SKILL_DIR/scripts/validate-workspace.mjs" "$ROOT"
```

After completion, report graph changes and each updated concept/derivation
document with ID, label when applicable, path, and reason.
