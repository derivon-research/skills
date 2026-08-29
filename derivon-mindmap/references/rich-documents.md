# Rich Object Documents

## Document roles

A concept document identifies one reusable understanding state: define it,
delimit its scope, connect it to prerequisites, and provide an example or boundary
when that helps. A derivation document explains one whole joint step: how every
tail contributes, what move the edge supplies, and exactly what head is reached.
Never assume the head as evidence.

Preserve source meaning. Authorized source wording may be reused directly when it
fits the object. Otherwise quote only what is needed and adapt faithfully with a
source location. Do not turn chapter adjacency into a graph relation.

## Format contract

Preserve `data.format`. New objects default to:

```text
<document-directory>/document.md   # source
<document-directory>/index.html    # synchronized publication
```

Markdown supports GFM, KaTeX delimiters, and raw HTML. Run the bundled renderer
after every Markdown edit. Use HTML-only only when the source is inherently a
complete HTML page or cannot reasonably retain a Markdown source.

## Interactive-example gate

Apply this gate when the user requests interactive material or static content has
proved insufficient during actual learning. Do not make a rich-media pass an
import or creation completion requirement. Add interaction only when changing
input, comparing representations, testing a boundary, observing state, or solving
a case teaches more directly than static text.

Every interaction needs:

- one explicit learning question;
- meaningful initial state and labeled controls;
- immediate, interpretable feedback;
- a readable noninteractive explanation;
- responsive normal flow without an internal page scrollbar;
- keyboard operation, visible focus, sufficient contrast, and reduced-motion
  behavior;
- offline-first self-containment;
- no assumption of parent DOM, workspace APIs, cookies, storage, or same origin.

Interaction supports but never replaces a formal definition, source-grounded
argument, or derivation explanation. Avoid decorative dashboards and controls
that merely restate text.

## Completion message

After a write cycle report, for example:

```text
Graph changes:
- Updated hyperedge determinant-volume -> singularity.

Updated documents:
- Concept determinant "Determinant": docs/determinant/document.md - added a geometric boundary example.
- Derivation determinant-volume: docs/determinant-volume/document.md - calibrated the explanation and weight rationale.

Interactive example:
- Added "Area collapse under a 2x2 transform" to Determinant (determinant). Open that document in Derivon Mindmap to manipulate it.
```

List only changed documents. A generic “documents updated” is not sufficient.
