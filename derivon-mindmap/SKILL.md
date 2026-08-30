---
name: derivon-mindmap
description: Operate a Derivon Mindmap workspace with derivon CLI and jq, apply the graph model to learning, maintain object documents and replacement views, validate and render publications, and export solved routes as previewable static textbooks. Use for .derivon/workspace.json or Mindmap project folders.
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
6. Stage graph output and candidate manifest in `.derivon`, render candidate
   Markdown publications, validate the candidate, then atomically replace the
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

For Markdown objects, `document.md` is source and `index.html` is publication:

```sh
node "$SKILL_DIR/scripts/render-documents.mjs" <workspace> <object-id>
node "$SKILL_DIR/scripts/render-documents.mjs" --write <workspace> <object-id>
node "$SKILL_DIR/scripts/validate-workspace.mjs" <workspace>
```

Preserve an existing object's format. New objects default to Markdown. Follow the
central rich-object contract for learner-visible output: use native Markdown
before static local images, raw HTML, or interaction; comments and placeholders
never count as visible content. Rich content and interaction remain optional.

After each write cycle, report graph changes and every updated document with
object ID/label, path, and reason. If an interactive example was added, name it
and prompt the user to open that object in Derivon Mindmap.

## Export a route textbook

```sh
node "$SKILL_DIR/scripts/export-route-textbook.mjs" <workspace> \
  --output <directory> --start <known-id> --target <goal-id> --serve
```

The exporter follows solver `executableOrder`, copies complete object directories,
adds navigation, emits `route.json`, protects existing output, and refuses an
unproven route unless `--allow-approximate` is explicit. Keep the loopback server
running, inspect representative desktop and narrow pages with available browser
tooling, and give the user the URL, output path, and stop command.
