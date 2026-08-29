---
name: derivon-cli
description: Install and use the derivon CLI, and reason correctly about weighted directed B-hypergraphs. Use for graph validation, point or hyperedge operations, closure and route queries, diagnosis, subgraphs, atomic apply batches, opaque data, empty tails, cycles, parallel hyperedges, and route weights.
---

# Derivon CLI

Use `derivon` as a stateless processor for the CLI-owned `derivon.graph/v1`
protocol. It reads one complete graph from stdin or `--input`, validates before
every operation, and writes JSON to stdout. It never edits a file itself.

Read [the mathematical model and command reference](references/model-and-cli.md)
before the first structural edit or whenever ordinary directed-graph intuition is
not enough.

## Establish the runtime

Run `derivon --version`. If unavailable, install it with one supported path:

```sh
brew install derivon-research/tap/derivon
cargo install derivon-cli
curl -fsSL https://docs.derivon.net/cli/install.sh | sh
```

## Preserve the mathematical model

- A point is a structural element identified by one ID. The CLI assigns it no
  application meaning.
- One hyperedge has zero or more tails, exactly one head, and one weight. Every
  tail is jointly required to enable the head; replacing a multi-tail hyperedge
  with separate single-tail hyperedges changes AND into OR.
- Distinct hyperedges remain distinct even when tails and head match. Parallel
  hyperedges are legal alternatives.
- An empty-tail hyperedge is enabled independently of the query start set and
  contributes its weight when selected.
- Cycles, self-dependencies, zero weights, empty tails, isolated points, and
  parallel hyperedges are legal.
- A route is a selected hyperedge set whose closure from the query starts
  contains every target. Its set cost is the sum of selected hyperedge weights,
  counting each selected hyperedge once.
- Point and hyperedge IDs share one case-sensitive ASCII namespace. Optional
  `data` is opaque JSON and has no CLI-defined schema or identity semantics.

## Inspect and operate

Use CLI commands directly:

```sh
derivon validate < graph.json
derivon point list < graph.json
derivon point get A < graph.json
derivon hyperedge get h-ab < graph.json
derivon point add B < graph.json
derivon hyperedge add h-ab --tail A --head B --weight 1.5 < graph.json
derivon apply --operations operations.json < graph.json
derivon query closure --start A < graph.json
derivon query route --start A --target B < graph.json
derivon query diagnose --start A --target B < graph.json
derivon subgraph route --start A --target B < graph.json
```

The CLI resolves structural objects by ID. To find objects by an application
field inside opaque `data`, list them and let the caller filter with a structured
JSON processor according to that caller's schema. Treat zero or multiple matches
as unresolved; never mutate from an ambiguous external name.

Mutations emit a complete graph. Capture stdout in a different file, validate it,
and only then replace persistent input. Do not redirect a mutation onto its input
path.

## Report results precisely

For mutations, report changed point and hyperedge IDs. For routes, report starts,
targets, selected hyperedges, executable order, set cost, bounds, and
`provenOptimal`. Unreachable is a successful query result, not malformed input;
explain blocking points and cycles. Never call an unproven witness optimal.
