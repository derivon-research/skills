# Derivon Mindmap Model

Derivon Mindmap applies the generic Derivon weighted directed B-hypergraph to
learning and explanation. These meanings belong to Mindmap, not to the core CLI.

## Application semantics

- A point is one reusable state of understanding or established claim. Its label
  and object document define scope for a target audience.
- One hyperedge is one genuine step by which every tail jointly supports one
  head. Its document explains how each tail contributes and what move establishes
  the head.
- Separate hyperedges are alternative derivations. Parallel hyperedges remain
  distinct because their argument, source, explanation, or audience cost may
  differ.
- An empty-tail hyperedge is a real entrance only when its head is learnable
  without graph prerequisites. It still has a weight and is not a substitute for
  a route query's learner-known start set.
- `view.replacements` changes presentation only. It does not assert derivation,
  equivalence, containment, ontology, or shared cost.

Chapter adjacency, chronology, similarity, citation, co-location, and ordinary
association do not establish a hyperedge. Record such evidence in documents or a
separate relation layer rather than falsifying derivation semantics.

## Atomic concepts and steps

A point must not bundle parts that can be defined, learned, derived, referenced,
or reused independently. Chinese `与`, `和`, `、`, English `and`, list punctuation,
and other coordination are mandatory review signals. A conventional coordinated
term stays one point only when evidence supports one indivisible understanding
state. Shortening a label is not a semantic split.

A hyperedge must expose reusable intermediate results instead of hiding several
substantial moves in one step. Every tail must contribute jointly. Do not merge
alternative routes into one AND tail set. Cycles, empty tails, and high weights
are review signals, not automatic errors.

## Mindmap weight rubric

A hyperedge weight is the target learner's marginal cognitive cost for
understanding and verifying the whole step after every tail is mastered.

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

The graph stores compact structure; object documents carry definitions,
boundaries, evidence, provenance, uncertainty, examples, and complete derivation
arguments. Read the point documents for every tail and head together with the
hyperedge document before changing a derivation. A structural edit without
synchronized owning documents is incomplete.
