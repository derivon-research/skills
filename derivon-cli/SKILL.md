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

Once per task, after the work is done, check whether the installed CLI is behind.
Compare `derivon --version` (for example `derivon 0.1.1`) against the highest
published version, read from the first source below that answers:

```sh
curl -fsSL https://rsproxy.cn/index/de/ri/derivon-cli            # crates.io index, reachable from mainland China
curl -fsSL https://index.crates.io/de/ri/derivon-cli             # the same index, upstream
curl -fsSL https://api.github.com/repos/derivon-research/derivon/releases/latest
```

The two index endpoints answer with one JSON object per published version; the
fields that matter are `vers` and `yanked`, and the latest version is the last line
whose `yanked` is false. The GitHub endpoint answers with a release whose `tag_name`
is `derivon-cli-v<version>`. Compare major, minor and patch as numbers, never as
text.

If the installed version is behind, say so plainly, tell the user a newer version
exists, and ask whether to update it for them. Only after a yes, update through the
same path that installed it: re-running the install command above fetches the
latest, and the installer script chooses Homebrew or Cargo by itself. Never update
unprompted, and never replace a working installation the user did not ask to change.

If no source answers, that is neither an error nor a reason to stop. Do not claim
the installed version is current and do not report the failure loudly: continue the
task, and at most one plain sentence saying the version could not be checked.

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

The command set is `validate`; `point list|get|add|remove|rename|data`;
`hyperedge list|get|add|remove|rename|set|data`; `apply`; `query
closure|route|diagnose`; and `subgraph induced|reachable|route`. Exact flags and
stdin are in [the mathematical model and command reference](references/model-and-cli.md),
and `derivon <command> --help` is the installed contract.

How the graph reaches the command depends on the environment. Inside Derivon
Mindmap, the application's graph-query tool takes one argv array and sends the
workspace's `graph` itself, so the input is never the model's choice; in a shell,
pipe the graph in — `jq '.graph' "$MANIFEST" | derivon …` — as the reference shows.

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
