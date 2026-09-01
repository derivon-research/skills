# skills

Derivon Agent Skills: the workflows that let a coding agent read and maintain a Derivon
Mindmap workspace correctly.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `derivon-research/skills`, via the `gh` CLI. Protocol
issues belong in the repo that owns the protocol (`derivon-research/derivon` for
`derivon.graph/v1`, `derivon-research/derivon-mindmap` for `derivon.authoring/v0.3.0`).
Strategy and roadmap live in the private `derivon-research/planning` repo, never here. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context. `CONTEXT.md` and `docs/adr/` already exist and are normative for authoring
*methodology* (problem pressure, problem-led derivation) only; protocol and model terms are
owned elsewhere. See `docs/agents/domain.md`.
