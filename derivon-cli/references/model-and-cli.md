# Model and CLI Reference

## Core graph

A graph contains `points` and weighted directed B-hyperedges:

```json
{
  "points": [{"id":"A","data":{"label":"A"}}],
  "hyperedges": [{"id":"h","weight":1.5,"tails":["A"],"head":"B","data":{}}]
}
```

The optional graph schema is `derivon.graph/v1`. Point and hyperedge IDs share
one ASCII namespace and match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Hyperedge
tails are unique point IDs, may be empty, and jointly imply one existing head.
Opaque `data` does not participate in route solving.

A route is a set of hyperedges that can execute from a query-specific start set
and reach every target. Its set cost counts each selected hyperedge once. The
reported `executableOrder` is a valid order for learning the selected steps; the
mathematical route remains a set.

## AND, OR, and empty tails

`[A, B] -> C` is one joint step. Replacing it with `A -> C` and `B -> C` changes
AND into OR. Two distinct `[A, B] -> C` hyperedges are alternative routes. An
empty-tail hyperedge `[] -> A` is available in every query and incurs its weight;
it does not mean that one learner already knows A.

## Learning-cost anchors

Weight means marginal effort to understand and verify the whole step after all
tails are mastered.

| Weight | Anchor |
| ---: | --- |
| 0 | Definition unfolding, notation translation, or immediate scoped equivalence. |
| 1 | Direct application with no meaningful method choice. |
| 2 | Routine combination or short standard calculation. |
| 3 | Non-obvious observation, choice, interpretation, or construction. |
| 4 | Key technique or substantial conceptual bridge needing guidance. |
| 5 | Major learning unit or difficult argument that is itself a milestone. |

This is a continuous application rubric, not an integer enum. Start with integers
or halves. Use tenths only after comparison or observed evidence. Review weights
at or above 4 for hidden reusable intermediates, but do not split a difficult yet
atomic move mechanically. Importance, page count, tail count, and head difficulty
are not formulas for weight.

Exploration may calibrate for one user. Creation and book import freeze a target
audience and use that audience consistently.

## Commands

```text
validate
point list|get|add|remove|rename|data get|data set|data remove
hyperedge list|get|add|remove|rename|set tails|set head|set weight|data get|data set|data remove
query closure|route|diagnose
subgraph route|reachable|induced
apply
```

Global options include `--input`, `--pretty`, resource limits, help, and version.
Mutation output is the full graph. Query commands do not mutate input. `apply`
accepts a typed operation array from a file and is atomic in process memory.

Use `derivon <command> --help` and <https://docs.derivon.net/cli/> for the exact
versioned contract. Prefer stable long flags in scripts.

## Route interpretation

A reachable route result includes:

- `startPointIds`, `targetPointIds`, `pointIds`, and `hyperedgeIds`;
- `executableOrder`;
- `cost`, `lower`, and `upper`;
- `provenOptimal`, search nodes, and elapsed milliseconds.

An unreachable result contains target diagnoses and omits inapplicable route
fields. A budget-limited reachable result may be a useful witness without being
proven optimal. Increase the budget or label it explicitly.
