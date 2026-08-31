# Philosophy to CS Exploration Eval

This manual behavior regression exercises `derivon-exploration` against a broad
historical learning goal that previously produced a speculative roadmap batch,
rigid document templates, and duplicated arguments across concepts and
derivations.

## Run

1. Start a fresh Agent session with the repository versions of `derivon-cli`,
   `derivon-mindmap`, and `derivon-exploration` available.
2. Use a new strict empty Mindmap workspace.
3. Submit [prompt.md](prompt.md) without extra steering.
4. Let the Agent publish its first teaching batch, explain it, and ask its first
   non-recall verification question. Stop before supplying learner evidence.
5. Inspect the graph and every source document in that batch.

## Acceptance rubric

The run passes only when every item is supported by the produced graph,
documents, and conversation.

- **Bounded question**: the workspace description records the broad direction,
  while the first graph write answers one concrete question. Future eras and
  desired destinations have not become speculative roadmap objects.
- **Concept ownership**: each concept document states one understanding, its
  scope, and useful boundaries. Arguments from graph prerequisites live in
  derivation documents and are linked rather than duplicated.
- **Problem-led derivation**: each derivation exposes one concrete historical,
  logical, or pedagogical pressure and performs one identifiable resolving move
  that depends on the full tail set and establishes one head without assuming it.
  Removing any tail breaks the account.
- **Provenance**: the reader can distinguish documented historical pressure from
  an Agent-composed logical or pedagogical reconstruction without relying on a
  mandatory metadata heading.
- **Responses rather than chronology**: distinct answers to one pressure fan out
  to distinct heads. A later viewpoint uses an earlier viewpoint as a tail only
  when the derivation explains an actual summary, refinement, rejection, or
  other reasoning dependency.
- **Useful labels**: a named viewpoint combines its author or school with a
  plain-language thesis. Person-only and era-only points are absent.
- **Plainspoken publication**: subjects and main claims appear early, each
  sentence has one main teaching job, parallel ideas use parallel grammar, and
  the paragraphs remain coherent rather than telegraphic.
- **Provisional lifecycle**: initial weights are provisional. The Agent requests
  a non-recall task before claiming observed understanding or observed weights.
- **Flexible form**: headings and paragraph shapes follow each object's teaching
  content. Repeated boilerplate sections appear only when they carry real
  information.

Use [golden-concept.md](golden-concept.md) and
[golden-derivation.md](golden-derivation.md) to calibrate content ownership and
prose quality. They are positive examples, not exact-output snapshots; different
structure and wording pass when they satisfy the rubric.
