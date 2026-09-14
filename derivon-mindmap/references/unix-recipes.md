# Unix Workspace Recipes

These recipes require a POSIX shell, `jq`, `derivon`, Node.js, and an absolute
installed skill path:

```sh
set -eu
SKILL_DIR=/absolute/path/to/installed/derivon-mindmap
WORKSPACE=/absolute/path/to/workspace
MANIFEST="$WORKSPACE/.derivon/workspace.json"
CMD="node $SKILL_DIR/scripts/derivon-workspace.mjs"
```

Resolve `SKILL_DIR` from the loaded skill location. Do not guess an Agent-specific
installation directory.

`$CMD` is the script command surface. Every write goes through it and one call is
one commit: the command builds the candidate, validates the graph and the
workspace reference rules, writes the documents it owns first, and replaces the
manifest last. There is no staged candidate to check first. Run
`$CMD --capabilities` for the machine-readable command list, argv, stdin and
capabilities.

`derivon` remains a stateless processor. Use `jq | derivon | jq` directly for
reads and queries only.

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

For a new workspace, name its identity and start with only a strict empty v1
manifest. `import` validates it and creates the manifest atomically:

```sh
set -eu
ROOT=/absolute/path/to/new-workspace
SKILL_DIR=/absolute/path/to/installed/derivon-mindmap
CMD="node $SKILL_DIR/scripts/derivon-workspace.mjs"
ID=my-workspace
mkdir -p "$ROOT/.derivon"
[ ! -e "$ROOT/.derivon/workspace.json" ] || { printf '%s\n' "Refusing to replace an existing manifest" >&2; exit 1; }
jq -n --arg id "$ID" --arg title 'Untitled Mindmap' --arg description '' '{
  schema: "derivon.workspace/v1",
  id: $id,
  document: {title: $title, description: $description},
  graph: {points: [], hyperedges: []}
}' | $CMD import "$ROOT"
$CMD validate "$ROOT"
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
$CMD validate "$ROOT"
$CMD render "$ROOT"
jq '.graph' "$MANIFEST" | derivon validate --pretty
jq '.graph' "$MANIFEST" | derivon point list --pretty
jq '.graph' "$MANIFEST" | derivon point get A --pretty
jq '.graph' "$MANIFEST" | derivon point data get A --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge list --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge get h-ab --pretty
jq '.graph' "$MANIFEST" | derivon hyperedge data get h-ab --pretty
```

`validate --manifest <candidate.json> <workspace>` audits one candidate manifest
against a workspace without replacing anything. It is an audit, never a required
step before a write.

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

## Add a point and document

Object ids are generated, never chosen: the `new-object-id` command mints one in the same
shape the application does — `c-` or `h-` plus six lowercase characters from an alphabet
without `0 1 i l o u`, random so a deleted id is never handed out again. Ids need only be
unique inside one graph.

`add-concept` writes the document and commits the graph object that owns it in one
call. Mint the id through the command surface too:

```sh
ID=$($CMD new-object-id "$ROOT" --kind concept | jq -r '.result.id')
DOC="docs/concept-${ID#c-}"
MARKDOWN=$(mktemp)
trap 'rm -f "$MARKDOWN"' 0 1 2 15
printf '%s\n' '# Limit' '' 'Source-grounded definition, scope, and example.' > "$MARKDOWN"

jq -cn --arg id "$ID" --arg label 'Limit' --arg document "$DOC" \
  --arg description 'The value a function approaches.' --rawfile markdown "$MARKDOWN" \
  '{id:$id, data:{label:$label, description:$description, document:$document}, markdown:$markdown}' \
  | $CMD add-concept "$ROOT"
rm -f "$MARKDOWN"
trap - 0 1 2 15
```

Omit `markdown` to adopt a `document.md` that already exists, for example one
extracted from a source. Coordination in a proposed label requires the atomicity
review from the Mindmap model. If the call refuses, the manifest is unchanged and a
document directory the command created is removed again.

## Add a hyperedge and document

Read every tail, the proposed derivation source, and the head together. Every tail
must contribute; distinct arguments become parallel hyperedges.

```sh
ID=$($CMD new-object-id "$ROOT" --kind derivation | jq -r '.result.id')
DOC="docs/derivation-${ID#h-}"
MARKDOWN=$(mktemp)
trap 'rm -f "$MARKDOWN"' 0 1 2 15
printf '%s\n' '# Sum rule for limits' '' \
  'Explain how every premise contributes and what establishes the head.' > "$MARKDOWN"

jq -cn --arg id "$ID" --arg document "$DOC" --arg label 'Sum rule for limits' \
  --argjson tails '["limit-f","limit-g"]' --arg head 'limit-sum-result' --argjson weight '2.0' \
  --rawfile markdown "$MARKDOWN" \
  '{id:$id, tails:$tails, head:$head, weight:$weight, data:{label:$label, document:$document}, markdown:$markdown}' \
  | $CMD add-derivation "$ROOT"
rm -f "$MARKDOWN"
trap - 0 1 2 15
```

Omit every tail only for a genuine no-prerequisite Mindmap entrance. `add-derivation`
takes the tail list as JSON, so an empty tail is `--argjson tails '[]'`.

## Apply a related batch

Each `add-*` call is its own commit, so an ordered batch is a sequence of calls
that each leave the workspace valid:

```sh
B_MD=$(mktemp); E_MD=$(mktemp)
trap 'rm -f "$B_MD" "$E_MD"' 0 1 2 15
printf '%s\n' '# B' '' 'Define B.' > "$B_MD"
printf '%s\n' '# A to B' '' 'Explain how A establishes B.' > "$E_MD"

jq -cn --arg id B --arg label B --arg document docs/b --rawfile markdown "$B_MD" \
  '{id:$id, data:{label:$label, document:$document}, markdown:$markdown}' \
  | $CMD add-concept "$ROOT"

EDGE=$($CMD new-object-id "$ROOT" --kind derivation | jq -r '.result.id')
jq -cn --arg id "$EDGE" --arg document "docs/derivation-${EDGE#h-}" \
  --argjson tails '["A"]' --arg head B --argjson weight '1.5' --rawfile markdown "$E_MD" \
  '{id:$id, tails:$tails, head:$head, weight:$weight, data:{document:$document}, markdown:$markdown}' \
  | $CMD add-derivation "$ROOT"
rm -f "$B_MD" "$E_MD"
trap - 0 1 2 15
```

## Migrate a complete manifest

`import` validates one complete manifest and replaces the current one in a single
commit. It never writes documents; every document it references must already
exist. Build the candidate with `jq` and feed it in:

```sh
CANDIDATE=$(mktemp)
trap 'rm -f "$CANDIDATE"' 0 1 2 15
jq '...the migration...' "$MANIFEST" > "$CANDIDATE"
$CMD import "$ROOT" < "$CANDIDATE"
rm -f "$CANDIDATE"
trap - 0 1 2 15
```

## Replace a document body

`write-document` replaces exactly one `document.md` and refuses when the file
changed since it read it:

```sh
jq -cn --arg object "$ID" --rawfile markdown revised-document.md \
  '{object:$object, markdown:$markdown}' | $CMD write-document "$ROOT"
```

## Change metadata, tags, or object data

`set-metadata` replaces `document.title`/`description`, the whole tag declaration
list, or whole `data` objects by id:

```sh
jq -cn --argjson document '{"title":"Renamed"}' \
  --argjson tags '[{"id":"starting","label":"Starting points"}]' \
  '{document:$document, tags:$tags}' | $CMD set-metadata "$ROOT"

jq -cn --argjson objects '{"A":{"data":{"label":"New label","document":"docs/a"}}}' \
  '{objects:$objects}' | $CMD set-metadata "$ROOT"
```

`data` is replaced whole and must still satisfy the workspace protocol — a point
still needs `label` and `document`, a hyperedge still needs `document`.

## Reject a stale write

Every structural command re-reads the manifest before replacing it and refuses the
whole call when the bytes changed since it read them. The refusal is an envelope
with `issues[0].code` equal to `conflict-precondition` and exit code 1. Re-read the
manifest and retry; there is nothing to clean up and no partial write to undo.

```sh
payload=$(jq -cn --argjson document '{"title":"Renamed"}' '{document:$document}')
out=$($CMD set-metadata "$ROOT" <<<"$payload") || true
jq -r '.issues[] | "\(.code): \(.path): \(.message)"' <<<"$out"
```

## Crosslink, validate, and report

```sh
$CMD crosslink "$ROOT" ID...
$CMD crosslink "$ROOT" --all --check      # report only
$CMD render "$ROOT" ID...
$CMD validate "$ROOT"
```

Crosslink exact changed objects after editing prose. Check a broad migration with
`--all --check` and get confirmation before `--all`. After completion, report point
and hyperedge changes separately and list each updated concept/derivation document
with ID, label when applicable, relative path, and reason.

## Export a route textbook

```sh
$CMD export-textbook "$ROOT" --output /absolute/textbook \
  --start A --target Z

# Interactive preview is a long-running server, not a commit. Run the bundle directly.
node "$SKILL_DIR/scripts/export-route-textbook.mjs" "$ROOT" \
  --output /absolute/textbook --start A --target Z --serve
```

`export-textbook` writes its report into the envelope's `result` — `output`,
`chapters`, and `references`. The preview server binds loopback; give the user the
URL, output path, and stop command.
