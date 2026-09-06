---
name: derivon-mindmap
description: Operate a Derivon Mindmap workspace with derivon CLI and jq, apply the graph model to learning, maintain object documents and replacement views, validate Markdown documents, and export solved routes as previewable static textbooks. Use for .derivon/workspace.json or Mindmap project folders.
---

# Derivon Mindmap

Use this skill with `derivon-cli`. A Mindmap workspace contains an authoring
manifest plus one owned document directory per point and hyperedge. The core CLI
only consumes `manifest.graph`; Mindmap owns labels, learning semantics,
documents, projection, and cognitive-cost interpretation.

Before editing, read:

- [Mindmap model semantics](references/mindmap-model.md) before any structural
  edit or weight decision
- [Unix workspace recipes](references/unix-recipes.md) before inspecting or
  writing a workspace
- [Object document contract](references/object-documents.md) before creating or
  revising any concept or derivation source document
- [Rich object document guidance](references/rich-documents.md) when the user
  requests rich content or when static material proves insufficient during
  actual learning

Resolve this installed skill directory to an absolute `SKILL_DIR` before running
its scripts.

## Start safely

1. Find the nearest `.derivon/workspace.json`; do not infer the root from `docs/`.
2. For a new project, create only the strict empty v0.3 manifest from the Unix
   recipe. Do not add sample points, fake entrances, layout state, Agent files, or
   session files.
3. Run `node "$SKILL_DIR/scripts/validate-workspace.mjs" <workspace>`.
4. Read the full manifest and every affected object's source document.
5. For a hyperedge, read all tail documents, its derivation document, and the head
   document together.
6. Stage graph output and candidate manifest in `.derivon`, check candidate
   Markdown and media without writing HTML, validate the candidate, then atomically replace the
   manifest.

Use direct `jq | derivon | jq` recipes for normal operations. Do not hide point,
hyperedge, route, or subgraph commands behind another CRUD wrapper.

## Keep authoring and core semantics separate

- `graph` is the mathematical input.
- Point/hyperedge `data` owns Mindmap labels and document directories.
- `view.replacements` changes visual projection only.
- Runtime positions, viewport, selection, compare mode, and workflow state do not
  belong in the manifest.
- Removing a graph object does not authorize deleting its document directory.

Run destructive changes only after reporting affected references, replacements,
documents, and rewired semantics. Cascade, split, rename, remove, and broad
rewiring require confirmation.

## Publish documents

Each object persists only `document.md`, including any inline HTML. The application
renders it on demand while browsing. Never generate, save, require, or link to a
standalone `index.html` in a workspace. Leave existing unrelated HTML files untouched.
Crosslink exact changed objects before read-only Markdown/media validation:

```sh
node "$SKILL_DIR/scripts/crosslink-documents.mjs" --write <workspace> <object-id>...
node "$SKILL_DIR/scripts/render-documents.mjs" <workspace> <object-id>...
node "$SKILL_DIR/scripts/validate-workspace.mjs" <workspace>
```

Use `--manifest <candidate.json>` for both document tools before an atomic
manifest replacement. Crosslinks are reading navigation only and never authorize
graph edits. Check a broad migration with `--all --json`; do not run
`--write --all` without an impact summary and confirmation.

Preserve Markdown and its inline HTML verbatim outside the requested edits. Follow the
central object-document contract for every learner-visible source. Use native
Markdown before static local images, raw HTML, or interaction; comments and
placeholders never count as visible content. Rich content and interaction remain
optional.

After each write cycle, report graph changes and every updated document with
object ID/label, path, and reason. If an interactive example was added, name it
and prompt the user to open that object in Derivon Mindmap.

## Export a route textbook

```sh
node "$SKILL_DIR/scripts/export-route-textbook.mjs" <workspace> \
  --output <directory> --start <known-id> --target <goal-id> --serve
```

The exporter renders Markdown into a separate textbook output, never into workspace
object directories. It follows solver `executableOrder`, copies complete object directories,
rewrites known workspace links, copies their bounded transitive reference closure,
adds route/reference navigation, emits `route.json`, protects existing output, and
refuses an unproven route unless `--allow-approximate` is explicit. Keep the loopback server
running, inspect representative desktop and narrow pages with available browser
tooling, and give the user the URL, output path, and stop command.
