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

## Author for the visible publication

Preserve `data.format`. New objects default to:

```text
<document-directory>/document.md   # authoring source
<document-directory>/index.html    # learner-visible publication
```

The renderer converts GFM, KaTeX delimiters, Markdown images, and raw HTML into
`index.html`. Think through what that HTML displays. An HTML comment such as
`<!-- source-figure: page 147 -->` is invisible; it records metadata but does not
insert a figure or satisfy a request.

Use the least powerful representation that carries the teaching meaning:

1. Use native Markdown/GFM/KaTeX for prose, headings, lists, tables, code, links,
   and mathematics.
2. Use a local static image through Markdown for a static figure or diagram.
3. Use complete, visible raw HTML only for a concrete capability Markdown lacks.
4. Add HTML/CSS/JavaScript interaction only under the gate below.
5. Use HTML-only only when the source is inherently a complete page or cannot
   reasonably retain Markdown source.

## Static figures and owned assets

Put every Agent-authored media dependency inside the consuming object's document
directory. Refer to it with a relative path:

```markdown
![A closed series circuit with one current path](./closed-series-circuit.png)

*Figure: Closing the switch completes one path through the lamp. Source: p. 147,
Figure 6-3.*
```

Alt text states the information a learner needs from the figure. A visible
caption says why the figure is present and gives the source location. Invisible
provenance may supplement these, never replace them.

Keep each object independently publishable. If another object needs the same
figure, copy the required asset into that object's directory rather than adding a
shared asset convention. Agent-authored publications must work offline: do not
use HTTP/CDN, protocol-relative, absolute, `file://`, `data:`, or `blob:` media
and dependency URLs. Ordinary external citation links remain allowed.

Markdown images are the default for static media. Raw `<img>` or `<picture>` is
acceptable only when it provides a needed capability such as responsive sources
or belongs to complete existing HTML; it follows the same alt, provenance,
local-path, and offline rules.

## Publication gate

Run the bundled renderer after every Markdown edit. Renderer success is the
publication gate: its media preflight checks local paths, supported image bytes
and dimensions, declarative HTML/CSS dependencies, and common invisible figure
placeholders before writing. It audits HTML-only `index.html` without rewriting
it. Do not claim a media write succeeded when the renderer rejects it. Browser screenshots and manual responsive inspection are
not mandatory for this workflow; source fidelity and pedagogical correctness
still require Agent judgment because structural checks cannot understand an
image.

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

For every changed figure, also report its object-relative asset path, visible
source citation, and whether it was extracted, cropped, or redrawn. List only
changed documents. A generic “documents updated” is not sufficient.
