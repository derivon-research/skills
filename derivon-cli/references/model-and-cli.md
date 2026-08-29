# Mathematical Model and CLI Reference

## Graph protocol

The CLI owns and accepts `derivon.graph/v1`:

```json
{
  "schema": "derivon.graph/v1",
  "points": [{"id":"A"}, {"id":"B"}],
  "hyperedges": [{"id":"h-ab","weight":1.5,"tails":["A"],"head":"B"}]
}
```

The `schema` field is optional; omission means exactly v1. Point and hyperedge
IDs share one namespace and match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
`tails` contains unique point IDs, may be empty, and has no mathematical order.
A hyperedge has exactly one existing head and an exact finite non-negative
weight in tenths units no greater than `900719925474099.1`.

Points and hyperedges may carry optional opaque JSON `data`. Validation and route
algorithms do not inspect it. Data commands address it with RFC 6901 JSON
Pointer; the caller owns its schema and meaning.

## B-hypergraph semantics

For `h = (T, v, w)`, all points in tail set `T` are jointly required before head
`v` becomes available. `[A, B] -> C` is therefore not equivalent to the two
hyperedges `A -> C` and `B -> C`. Multiple hyperedges with the same head are OR
alternatives. Distinct hyperedge IDs remain distinct even when all structural
fields match.

An empty-tail hyperedge is enabled in every closure computation. It is separate
from a query's explicit start set. Cycles, self-dependencies, empty tails,
parallel hyperedges, isolated points, zero weights, and zero-weight cycles are
valid.

Given starts `S` and targets `T`, a route is a hyperedge set `R` whose restricted
closure from `S` contains every target. Its set cost is:

```text
cost(R) = sum(weight(h)) for h in R
```

Each selected hyperedge is counted once even when reused by several targets or
branches. Minimum set cost over a B-hypergraph is not ordinary shortest path and
is NP-hard.

## Command surface

```text
validate
point list|get|add|remove|rename|data get|data set|data remove
hyperedge list|get|add|remove|rename|set tails|set head|set weight|data get|data set|data remove
query closure|route|diagnose
subgraph route|reachable|induced
apply
```

Global options include `--input`, `--pretty`, resource limits, help, and version.
Use `derivon <command> --help` and <https://docs.derivon.net/cli/> for the exact
installed contract.

## Inspection and data

```sh
derivon validate < graph.json
derivon point list < graph.json
derivon point get A < graph.json
derivon point data get A < graph.json
derivon point data get A /caller/owned/pointer < graph.json
derivon hyperedge list < graph.json
derivon hyperedge get h-ab < graph.json
derivon hyperedge data get h-ab < graph.json
```

`point get` and `hyperedge get` require structural IDs. For a caller-defined name
inside opaque `data`, use `point list` or `hyperedge list` and filter the JSON
array with `jq` according to the caller's own schema. Exact lookup may produce
zero, one, or multiple objects. Require one unique ID before mutation; fuzzy
matching is discovery only.

## Mutations

```sh
derivon point add B < graph.json
derivon point remove B < graph.json
derivon point remove B --cascade < graph.json
derivon point rename B C < graph.json
derivon point data set A /caller/owned/pointer --value 'null' < graph.json
derivon point data remove A /caller/owned/pointer < graph.json

derivon hyperedge add h-ab --tail A --head B --weight 1.5 < graph.json
derivon hyperedge remove h-ab < graph.json
derivon hyperedge rename h-ab h-ab-2 < graph.json
derivon hyperedge set tails h-ab --tail A --tail B < graph.json
derivon hyperedge set head h-ab C < graph.json
derivon hyperedge set weight h-ab 2.5 < graph.json
derivon hyperedge data set h-ab /caller/owned/pointer --value 'null' < graph.json
derivon hyperedge data remove h-ab /caller/owned/pointer < graph.json
```

Mutations emit the complete transformed graph. Point rename updates incident
references. Point removal fails when referenced unless `--cascade` is explicit.
`set tails` with no `--tail` creates an empty tail. Data set/remove follows JSON
Pointer rules and does not create missing intermediate parents.

For a batch that must succeed or fail together:

```sh
derivon apply --operations operations.json < graph.json
```

`apply` accepts a typed operation array and validates every intermediate graph.

## Queries and subgraphs

Every `--start` and `--target` is repeatable. Omitting every `--start` requests an
empty start set.

```sh
derivon query closure --start A --start B < graph.json
derivon query route --start A --target C --target D < graph.json
derivon query diagnose --start A --target C < graph.json

derivon subgraph induced --point A --point B < graph.json
derivon subgraph reachable --start A < graph.json
derivon subgraph route --start A --target C < graph.json
```

A reachable route reports `startPointIds`, `targetPointIds`, `pointIds`,
`hyperedgeIds`, `executableOrder`, `cost`, `lower`, `upper`, `provenOptimal`,
search nodes, and elapsed milliseconds. A budget-limited result may contain a
valid executable witness with `provenOptimal: false`; increase the budget or
label it as approximate. An unreachable result reports target diagnoses and is a
successful process result. Subgraph commands return an envelope containing
`.graph` and `.selection`, not a bare graph or a mutation result.
