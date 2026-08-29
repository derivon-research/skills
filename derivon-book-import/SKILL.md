---
name: derivon-book-import
description: Convert an authorized tutorial book into a source-faithful Derivon Mindmap one chapter at a time. Use for book, textbook, course-text, or tutorial imports that must preserve genuine derivations, atomic concepts, provenance, documents, and audience-calibrated learning costs.
---

# Derivon Book Import

Use `derivon-cli` and `derivon-mindmap` with this skill. Transform the source into
nonlinearly navigable concept and derivation documents. Do not transcribe its
table of contents into graph edges.

## Freeze the import

Record the source, authorization, target audience, covered chapters, language,
and whether this is a new or existing workspace. User-provided, owned, or
authorized material may be reused directly. For other public sources, use bounded
quotation and faithful adaptation with exact provenance.

Do not create a persistent loop/checkpoint file. To resume, ask which chapter to
continue from, then inspect source citations and existing graph content.

## Run one chapter transaction

1. Read the complete current chapter and the existing canonical point registry.
2. Extract reusable concepts, exact definitions/scope, genuine arguments or
   constructions, complete prerequisites, examples, source locations, and
   uncertainty.
3. Reconcile identity by meaning, not labels. Do not let a previous composite
   point become canonical merely because it already exists.
4. Form an edge only when the source supplies a real step by which all tails
   jointly support one head. Chapter order, adjacent sections, citation,
   chronology, similarity, and co-occurrence are not derivations.
5. Preserve distinct source arguments as parallel hyperedges. Split reusable
   intermediate results rather than hiding them inside a large edge.
6. Calibrate each whole-step weight for the frozen audience using the Mindmap
   model's 0-5 cognitive-cost anchors and record the rationale/source.
7. Write independently useful object documents. Preserve the author's wording and
   examples when authorized and on-topic; reorganize them by object without
   forcing paraphrase or copying unrelated chapter blocks. Rich media is not an
   import completion gate; when explicitly requested, follow the central
   `derivon-mindmap` rich-document contract.
8. Render Markdown, validate the candidate workspace, atomically write, and report
   exact graph/document changes for this chapter.
9. Continue automatically. Pause only when evidence cannot settle a semantic
   ambiguity or when a destructive revision of prior work needs confirmation.

## Enforce atomic concepts

Chinese `与`, `和`, `、`, English `and`, and other coordination are mandatory
review signals. If either part can be defined, learned, derived, reused, or
referenced independently, create separate points and model their actual relation.
A conventional coordinated term remains one point only when the source supports
one indivisible understanding state. Merely shortening the label is not a fix.

## Revise earlier chapters carefully

New chapters may automatically add source-backed concepts, parallel routes,
provenance, or prose. Before renaming, deleting, splitting, removing an edge, or
rewiring prior objects, show the old structure, new source evidence, proposed
structure, and affected objects; wait for confirmation.

## Finish the source range

Run full validation and representative route queries. Report imported chapters,
concept identity decisions, parallel routes, uncertain claims, high-weight
atomicity reviews, source/publication status, and every updated document. Do not
claim completion merely because every heading became a point.
