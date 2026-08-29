---
name: derivon-cli
description: Install and use the derivon CLI, and reason correctly about Derivon weighted directed B-hypergraphs. Use for graph validation, point or hyperedge operations, closure and route queries, subgraphs, atomic apply batches, model semantics, empty tails, cycles, parallel derivations, and learning-cost weights.
---

# Derivon CLI

Use `derivon` as a stateless JSON processor. It reads one core graph from stdin or
`--input`, validates before every operation, and writes JSON to stdout. It never
edits a file itself.

Read [the model and command reference](references/model-and-cli.md) before the
first structural edit or whenever ordinary directed-graph intuition is not enough.

## Establish the runtime

Run `derivon --version`. If unavailable, install it with one supported path:

```sh
brew install derivon-research/tap/derivon
cargo install derivon-cli
curl -fsSL https://docs.derivon.net/cli/install.sh | sh
```

Use `derivon-mindmap` alongside this skill when the input is a full Mindmap
workspace rather than a standalone graph fragment.

## Preserve the model

- A point is one reusable state of understanding or established claim.
- One hyperedge means every tail jointly supports one head through one atomic
  step. Tails are AND, not separate arrows.
- Separate hyperedges are alternatives. Parallel hyperedges are legal and remain
  separate because their documents or costs may differ.
- An empty tail is a graph-wide unconditional step with its own cost. It is not a
  query start set.
- Cycles, self-dependencies, zero weights, and empty tails are legal. Do not
  delete them merely because a DAG-oriented tool dislikes them.
- A weight belongs to the whole hyperedge and measures marginal cognitive cost
  after all tails are mastered. Never distribute it over visual connections.
- IDs are stable ASCII machine identifiers. Human labels belong in point data.

Coordination in a proposed label, including Chinese `与`, `和`, `、`, English
`and`, or list punctuation, is a mandatory atomicity review signal. Split parts
that can be defined, learned, derived, or reused independently. Shortening a
bundled label is not a semantic split.

## Operate through pipelines

Use CLI commands directly instead of inventing wrappers:

```sh
derivon validate < graph.json
derivon point add concept-b --data '{"label":"B"}' < graph.json
derivon hyperedge add h-ab --tail concept-a --head concept-b --weight 1.5 < graph.json
derivon apply --operations operations.json < graph.json
derivon query route --start concept-a --target concept-b < graph.json
derivon subgraph route --start concept-a --target concept-b < graph.json
```

Mutations emit a complete graph. Capture stdout in a temporary file, validate it,
and only then replace a persistent graph. Do not pipe a mutation back onto its
input path.

## Report outcomes

For mutations, report point and hyperedge changes separately. For routes, report
starts, targets, executable order, total cost, bounds, and `provenOptimal`.
Unreachable is a successful query result, not a process failure; explain blocking
points and cycles. Never call an unproven witness the optimal route.
