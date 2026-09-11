# Unix Workspace Recipes

These recipes require a POSIX shell, `jq`, `derivon`, Node.js, and an absolute
installed skill path:

```sh
set -eu
SKILL_DIR=/absolute/path/to/installed/derivon-mindmap
```

Resolve `SKILL_DIR` from the loaded skill location. Do not guess an Agent-specific
installation directory.

## Discover or initialize a workspace

Find the nearest manifest by walking upward from the current directory:

```sh
SEARCH=$PWD
ROOT=
while :; do
  if [ -f "$SEARCH/.derivon/workspace.json" ]; then ROOT=$SEARCH; break; fi
  [ "$SEARCH" != / ] || break
  SEARCH=$(dirname "$SEARCH")
done
[ -n "$ROOT" ] || { printf '%s\n' 'No .derivon/workspace.json found' >&2; exit 1; }
MANIFEST="$ROOT/.derivon/workspace.json"
```

For a new workspace, name its identity and start with only a strict empty v1 manifest:

```sh
set -eu
ROOT=/absolute/path/to/new-workspace
SKILL_DIR=/absolute/path/to/installed/derivon-mindmap
ID=my-workspace
MANIFEST="$ROOT/.derivon/workspace.json"
mkdir -p "$ROOT/.derivon"
[ ! -e "$MANIFEST" ] || { printf '%s\n' "Refusing to replace $MANIFEST" >&2; exit 1; }
NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX")
trap 'rm -f "$NEXT"' 0 1 2 15
jq -n --arg id "$ID" --arg title 'Untitled Mindmap' --arg description '' '{
  schema: "derivon.workspace/v1",
  id: $id,
  document: {title: $title, description: $description},
  graph: {points: [], hyperedges: []}
}' > "$NEXT"
node "$SKILL_DIR/scripts/validate-workspace.mjs" --manifest "$NEXT" "$ROOT"
mv "$NEXT" "$MANIFEST"
trap - 0 1 2 15
```

The top-level `id` is the workspace's identity: the user names it, `document.title` is only
the display name, and changing the id in the manifest is changing which workspace this is.
It becomes a directory name under the application data directory, so it is one filesystem-safe
path segment: lowercase ASCII letters (`a`–`z`), digits and hyphens only, starting and ending
with a letter or digit, no `/`, `\`, whitespace or `..`, at most 64 characters, and not a
Windows reserved device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`).
Uppercase is not in the alphabet, so case is never folded: the id is read as written, or
refused. The manifest is a broken workspace without one, and no part of the toolchain fills one
in. The normative rule is the `derivon-mindmap` README's 「工作区格式」; this recipe states it
so a shell session needs no second lookup.

Do not initialize sample objects, fake empty-tail entrances, runtime layout,
workflow state, Agent files, Git metadata, or object directories.

## Validate and inspect

```sh
node "$SKILL_DIR/scripts/validate-workspace.mjs" "$ROOT"
jq '.graph' "$MANIFEST" | derivon validate --pretty
jq '.graph' "$MANIFEST" | derivon point list --pretty
jq '.graph' "$MANIFEST" | derivon point get A --pretty
jq '.graph' "$MANIFEST" | derivon point data get A --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge list --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge get h-ab --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge data get h-ab --pretty
```

Mindmap labels are application data. Resolve an exact label before using a
structural ID:

```sh
LABEL='Exact label'
jq --arg label "$LABEL" '[.graph.points[] | select(.data.label == $label)]' "$MANIFEST"
```

Zero matches are unresolved. More than one match is ambiguous. For discovery
only, use case-insensitive containment and then inspect candidates:

```sh
TERM='partial text'
jq --arg term "$TERM" '[
  .graph.points[]
  | select(.data.label | ascii_downcase | contains($term | ascii_downcase))
  | {id, label: .data.label}
]' "$MANIFEST"
```

Never pass a fuzzy result into mutation until one unique structural ID is
confirmed.

Run every query and subgraph operation directly:

```sh
jq '.graph' "$MANIFEST" | derivon query closure --start A --start B --pretty
jq '.graph' "$MANIFEST" | derivon query route --start A --target Z --pretty
jq '.graph' "$MANIFEST" | derivon query route --target Z --pretty
jq '.graph' "$MANIFEST" | derivon query diagnose --start A --target Z --pretty
jq '.graph' "$MANIFEST" | derivon subgraph induced --point A --point B --pretty
jq '.graph' "$MANIFEST" | derivon subgraph reachable --start A --pretty
jq '.graph' "$MANIFEST" | derivon subgraph route --start A --target Z --pretty
```

Query output is not a manifest. Subgraph output is an envelope containing
`.graph` and `.selection`.

## Safe graph transaction

Define this helper in a fresh shell after `ROOT`, `MANIFEST`, and `SKILL_DIR`:

```sh
set -eu
commit_graph() (
  set -u
  GRAPH_TMP=$(mktemp "$ROOT/.derivon/graph.XXXXXX") || exit 1
  NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX") || exit 1
  trap 'rm -f "$GRAPH_TMP" "$NEXT"' 0 1 2 15

  if ! jq '.graph' "$MANIFEST" | derivon "$@" > "$GRAPH_TMP"; then exit 1; fi
  if ! derivon --input "$GRAPH_TMP" validate >/dev/null; then exit 1; fi
  if ! jq --slurpfile graph "$GRAPH_TMP" '.graph = $graph[0]' "$MANIFEST" > "$NEXT"; then exit 1; fi
  for OBJECT_ID in ${CHECK_IDS:-}; do
    if ! node "$SKILL_DIR/scripts/render-documents.mjs" --manifest "$NEXT" "$ROOT" "$OBJECT_ID"; then exit 1; fi
  done
  if ! node "$SKILL_DIR/scripts/validate-workspace.mjs" --manifest "$NEXT" "$ROOT" >/dev/null; then exit 1; fi
  if ! mv "$NEXT" "$MANIFEST"; then exit 1; fi
  rm -f "$GRAPH_TMP"
  trap - 0 1 2 15
)
```

Because the shell exits on any failed mutation or validation, `mv` is unreachable
on failure. Temporary files and the manifest are in `.derivon`, so the final
rename stays on one filesystem.

Use the complete mutation surface through the helper:

```sh
commit_graph point rename OLD NEW
commit_graph point remove ID
commit_graph point remove ID --cascade
CHECK_IDS=ID commit_graph point data set ID /label --value '"New label"'
CHECK_IDS=ID commit_graph point data set ID --value-file complete-point-data.json

commit_graph hyperedge rename OLD NEW
commit_graph hyperedge remove ID
commit_graph hyperedge set tails EDGE --tail A --tail B
commit_graph hyperedge set tails EDGE
commit_graph hyperedge set head EDGE C
commit_graph hyperedge set weight EDGE 2.5
CHECK_IDS=EDGE commit_graph hyperedge data set EDGE --value-file complete-edge-data.json
```

When a structural change also changes an owning Markdown explanation, edit its
`document.md` first and prefix the transaction with `CHECK_IDS='ID ...'` so the
candidate Markdown and media are checked without writing HTML before commit.

Mindmap point data requires `label` and `document`, and may carry `description` and
`tags`; hyperedge data requires `document` and may carry `label` and `description`.
Documents are Markdown only: every object owns only `document.md`, including any
inline HTML. Standalone HTML is not workspace content. Consequently, `point data remove` and `hyperedge data remove` are valid
core CLI commands but cannot produce a valid Mindmap workspace. The full validator
intentionally prevents committing such a candidate.

Object ids are generated, never chosen: `scripts/new-object-id.mjs` mints one in the same
shape the application does — `c-` or `h-` plus six lowercase characters from an alphabet
without `0 1 i l o u`, random so a deleted id is never handed out again. Ids need only be
unique inside one graph.

Before rename, remove, cascade, head/tail rewiring, or document-path replacement,
inspect incident edges, replacements, and owned documents; report impact and get
confirmation. Removing a graph object never deletes its document directory.

## Add a point and document

Create the required files before committing the graph object:

```sh
ID=$(node "$SKILL_DIR/scripts/new-object-id.mjs" --manifest "$MANIFEST" --kind concept)
DOC="docs/concept-${ID#c-}"
mkdir -p "$ROOT/$DOC"
printf '%s\n' '# Limit' '' 'Source-grounded definition, scope, and example.' > "$ROOT/$DOC/document.md"

POINT_DATA=$(jq -cn --arg label 'Limit' --arg document "$DOC" \
  --arg description 'The value a function approaches.' \
  '{label:$label,description:$description,document:$document}')
CHECK_IDS=$ID commit_graph point add "$ID" --data "$POINT_DATA"
```

Coordination in a proposed label requires the atomicity review from the Mindmap
model. If commit fails, leave the original manifest intact and remove the new
directory only after confirming it was created by this transaction and remains
unowned.

## Add a hyperedge and document

Read every tail, the proposed derivation source, and the head together. Every tail
must contribute; distinct arguments become parallel hyperedges.

```sh
ID=$(node "$SKILL_DIR/scripts/new-object-id.mjs" --manifest "$MANIFEST" --kind derivation)
DOC="docs/derivation-${ID#h-}"
mkdir -p "$ROOT/$DOC"
printf '%s\n' '# Sum rule for limits' '' \
  'Explain how every premise contributes and what establishes the head.' > "$ROOT/$DOC/document.md"

EDGE_DATA=$(jq -cn --arg document "$DOC" --arg label 'Sum rule for limits' \
  '{label:$label,document:$document}')
CHECK_IDS=$ID commit_graph hyperedge add "$ID" \
  --tail limit-f --tail limit-g --head limit-sum-result --weight 2.0 \
  --data "$EDGE_DATA"
```

Omit every `--tail` only for a genuine no-prerequisite Mindmap entrance.

## Apply a related batch

Create every required object directory first. Typed operations must leave every
intermediate core graph valid:

```sh
mkdir -p "$ROOT/docs/b" "$ROOT/docs/h-a-b"
printf '%s\n' '# B' '' 'Define B.' > "$ROOT/docs/b/document.md"
printf '%s\n' '# A to B' '' 'Explain how A establishes B.' > "$ROOT/docs/h-a-b/document.md"

OPS=$(mktemp "$ROOT/.derivon/operations.XXXXXX")
trap 'rm -f "$OPS"' 0 1 2 15
cat > "$OPS" <<'JSON'
[
  {"op":"point.add","id":"B","data":{"label":"B","document":"docs/b"}},
  {"op":"hyperedge.add","id":"h-a-b","tails":["A"],"head":"B","weight":1.5,"data":{"document":"docs/h-a-b"}}
]
JSON
CHECK_IDS='B h-a-b' commit_graph apply --operations "$OPS"
rm -f "$OPS"
trap - 0 1 2 15
```

`CHECK_IDS` makes the helper check changed Markdown and media against the candidate
manifest before replacement. Report every graph and document change after the
transaction succeeds.

## Safe replacement transaction

Replacement is projection state, not graph semantics. Define:

```sh
commit_manifest() (
  set -u
  FILTER=$1
  shift
  NEXT=$(mktemp "$ROOT/.derivon/workspace.XXXXXX") || exit 1
  trap 'rm -f "$NEXT"' 0 1 2 15
  if ! jq "$@" "$FILTER" "$MANIFEST" > "$NEXT"; then exit 1; fi
  if ! node "$SKILL_DIR/scripts/validate-workspace.mjs" --manifest "$NEXT" "$ROOT" >/dev/null; then exit 1; fi
  if ! mv "$NEXT" "$MANIFEST"; then exit 1; fi
  trap - 0 1 2 15
)
```

Create, toggle, and remove one replacement with complete validated transactions:

```sh
commit_manifest \
  '.view.replacements += [{points:$points,replaceWith:$target,show:"points"}]' \
  --argjson points '["A","B"]' --arg target C

commit_manifest \
  '(.view.replacements[] | select(.replaceWith == $target) | .show) = $show' \
  --arg target C --arg show replacement

commit_manifest \
  '.view.replacements |= map(select(.replaceWith != $target))' \
  --arg target C
```

The validator rejects duplicate members, conflicting targets, and cycles. Report
projection impact and obtain confirmation before removing or broadly changing a
replacement.

## Check, validate, and report

```sh
node "$SKILL_DIR/scripts/render-documents.mjs" "$ROOT"
node "$SKILL_DIR/scripts/render-documents.mjs" "$ROOT" ID
node "$SKILL_DIR/scripts/validate-workspace.mjs" "$ROOT"
```

After completion, report point and hyperedge changes separately and list each
updated concept/derivation document with ID, label when applicable, relative
path, and reason.
