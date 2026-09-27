# Derivon Mindmap Model

Derivon Mindmap applies the generic Derivon weighted directed B-hypergraph to
learning and explanation. These meanings belong to Mindmap, not to the core CLI.

## Application semantics

- A point is one reusable state of understanding or established claim. Its label
  and object document define scope for a target audience.
- One hyperedge is one problem-led response in which the full tail set is jointly
  required for one head. Its document exposes the historical, logical, or
  pedagogical problem pressure and performs one identifiable resolving move that
  depends on the full tail set and establishes the head.
- Problem pressure remains inside the hyperedge by default. It becomes a point
  only when understanding the problem is independently learnable and reusable.
- Distinct responses to the same pressure may fan out to different heads.
  Parallel hyperedges share tails and head but remain distinct because their
  argument, source, explanation, or audience cost differs.
- An empty-tail hyperedge is a real entrance only when its head is learnable
  without graph prerequisites. It still has a weight and is not a substitute for
  a route query's learner-known start set.
- Presentation is not graph semantics. `derivon.workspace/v1` carries no replacement
  view: nothing in the manifest asserts derivation, equivalence, containment,
  ontology, or shared cost.

Chapter adjacency, chronology, similarity, citation, co-location, and ordinary
association do not establish a hyperedge. Record such evidence in documents or a
separate relation layer rather than falsifying derivation semantics.

## Atomic concepts and steps

A point must not bundle parts that can be defined, learned, derived, referenced,
or reused independently. Chinese `与`, `和`, `及`, `、`, `并且`, English `and`, list
punctuation, and other coordination are mandatory review signals. A conventional
coordinated term stays one point only when evidence supports one indivisible
understanding state. Shortening a label does not split a bundle.

Coordination words only catch bundles that the label shows. Read the document too,
and apply these rules:

- **A term that documents use as a concept has its own point.** If an object
  document relies on an idea, such as "operator" or "algebraic multiplicity", and
  no point holds it, add the point and its derivation.
- **A definition point defines one concept.** A second concept introduced in
  passing is split out: an incidence-matrix point must not also define graph, path
  and tree.
- **A definition point asserts no theorem.** A claim stated inside a definition
  becomes its own point with its own hyperedge.
- **Split a proposition whose parts have different arguments** when downstream work
  can use one part alone, even if every current consumer happens to need all parts
  (the left and right distributive laws). A part with its own derivation and its
  own downstream use is always split.
- **Keep a proposition whole** when its parts come from one argument and nothing
  uses them separately, or when the point has no out-edges at all. Splitting then
  only adds learning cost; split when a real consumer appears.

A concept label is a short noun-like **handle**, because the canvas shows one line
of about 8 CJK characters and cuts the rest. Keep it at most 8 units wide, counting
a CJK or fullwidth character as 1 and any other character as 0.5. A proposition is
still one point, since tails and heads can only be points, but its full statement
goes in `data.description` and the first sentence of its concept document. Use the
name the subject uses (`秩–零化度定理`). When there is none, coin a handle that does
not read as a definition: `零空间维数公式`, not `零空间维数`, for "the null space has
dimension n − r".

**Names may repeat.** When one name covers several definitions or cases, such as
the determinant by three properties and by alternating forms, each definition is
its own concept, and all of them carry the subject's name. The id tells nothing
apart: it is an opaque identity. The concept's own fields do that:

- `data.description` says which definition or case this concept is and how it
  differs from the others with the same name.
- `data.qualifier`, optional, is a few characters (`三条性质`, `交错型`) shown under
  the name on the canvas and after it in lists. Keep it within the same 8 units.
  Any concept may have one.

A derivation that proves one definition from another is an ordinary hyperedge; each
proved direction is its own. See derivon-mindmap ADR-0014.

`validate` checks every concept label and lists what needs review in
`result.labelReviews`: `coordination` for a coordination signal, `length` for a
label wider than 8, `shared-name` for a shared name whose description or qualifier
does not yet tell this concept apart, and `qualifier-length` for a qualifier wider
than 8. These advisories never fail validation, and a batch is done only when each
one is resolved, in this order:

1. **Split** the point when its parts can be defined, derived, or referenced
   independently, and model their actual relation.
2. **Shorten** the label or qualifier, moving the statement into
   `data.description` and the document's first sentence. For `shared-name`, keep
   the name and write the difference into the description and a qualifier instead.
3. **Acknowledge** with `review-label` and a reason only when the concept must stay
   as it is, such as a conventional coordinated term. The record keeps the exact
   label, and for `qualifier-length` the qualifier, so a change puts it up for
   review again.

A hyperedge must expose reusable intermediate results instead of hiding several
substantial moves in one step. It contains one problem pressure and one
identifiable resolving move. The full tail set must be jointly necessary:
removing any tail breaks the problem-to-response account. A later viewpoint uses
an earlier viewpoint as a tail only when it actually summarizes,
refines, rejects, or otherwise reasons from it; chronology supplies no tail. Do
not merge alternative routes into one AND tail set. Cycles, empty tails, and high
weights are review signals, not automatic errors.

## Mindmap weight rubric

A hyperedge weight is the target learner's marginal cognitive cost for
understanding the problem pressure and verifying the whole resolving move after
every tail is mastered.

| Weight | Mindmap anchor |
| ---: | --- |
| 0 | Definition unfolding, notation translation, or immediate scoped equivalence. |
| 1 | Direct application with no meaningful method choice. |
| 2 | Routine combination or short standard calculation. |
| 3 | Non-obvious observation, choice, interpretation, or construction. |
| 4 | Key technique or substantial conceptual bridge needing guidance. |
| 5 | Major learning unit or difficult argument that is itself a milestone. |

The scale is continuous, not an enum. Start with integers or halves. Use tenths
only after comparison or observed evidence. Review weights at or above 4 for a
hidden reusable intermediate, but do not split a difficult atomic move merely to
lower its number. Importance, page count, tail count, and head difficulty are not
weight formulas.

Book Import and Creation freeze a target audience and estimate consistently for
that audience. Exploration may personalize weights from one learner's observed
effort. Always record the audience or personal evidence and weight rationale in
the owning hyperedge document.

## Documents own meaning

The graph stores compact structure. Concept documents state and delimit an
understanding; derivation documents own the complete problem-to-response account.
Together they carry evidence, provenance, uncertainty, examples, and weight
rationale. Read the point documents for every tail and head together with the
hyperedge document before changing a derivation. A structural edit without
synchronized owning documents is incomplete.
