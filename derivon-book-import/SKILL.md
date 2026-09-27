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
the memorisation weight, and whether this is a new or existing workspace. User-provided, owned, or
authorized material may be reused directly. For other public sources, use bounded
quotation and faithful adaptation with exact provenance.

Do not create a persistent loop/checkpoint file. To resume, ask which chapter to
continue from, then inspect source citations and existing graph content.

## Run one chapter transaction

1. Read the complete current chapter and the existing canonical point registry.
2. Inventory **all general content** of the body text: definitions, theorems,
   corollaries, properties, conclusions stated in remarks, general results proved
   inside worked examples, generalisations left to the reader, and every name the
   source uses as a concept (a *component* of a vector, a *natural basis*). Leave
   out purely numerical worked examples and exercises. The aim is a faithful record
   of the whole source, because later comparisons use routes (syllabi, other
   books, solver targets) that reach parts this source's own route skips; "nothing
   downstream uses it" is therefore no reason to leave an item out. For each item
   extract exact definitions/scope, genuine arguments or constructions, complete
   prerequisites, meaning-bearing figures, source locations, and uncertainty. The
   inventory is complete when every item of the chapter is matched to a point and
   to the source's derivation of it, or reported as deliberately left out.
3. Reconcile identity by meaning, not labels. Do not let a previous composite
   point become canonical merely because it already exists.
4. Form an edge only when the source supplies a real step by which all tails
   jointly support one head. An argument the source gives inside a worked example
   is such a step. Chapter order, adjacent sections, citation, chronology,
   similarity, and co-occurrence are not derivations. What the source only
   asserts, and a definition it motivates only later, are handled as described
   below.
5. Read the existing derivations with the same head before adding one, and decide
   between **reuse** and a **parallel** hyperedge:
   - The source reuses an existing derivation when that derivation makes the
     source's move and all its tails are concepts the source has already
     introduced. Add nothing; list its id among the chapter's reused derivations,
     so the source's route stays complete.
   - Add a parallel hyperedge when the source argues differently, when it motivates
     the step from a concept the existing derivation lacks, or when the existing
     derivation needs a concept the source has not introduced yet.

   Split reusable intermediate results rather than hiding them inside a large edge.
6. Calibrate each whole-step weight for the frozen audience using the Mindmap
   model's 0-5 cognitive-cost anchors and record the rationale/source.
7. Write independently useful object documents. Preserve the author's wording and
   examples when authorized and on-topic; reorganize them by object without
   forcing paraphrase or copying unrelated chapter blocks. Follow the central
   `derivon-mindmap` rich-document contract and its least-powerful representation
   rule. Meaning-bearing source figures are source fidelity, not an optional
   rich-media pass.
8. Commit through the `derivon-mindmap` command surface, which validates the graph
   and the workspace references in the same call that writes the documents first
   and replaces the manifest last. Link the changed documents as the
   `derivon-mindmap` object-document contract says, render Markdown, and report every graph, source-document, publication, and
   inserted-reference change for this chapter, including the reused derivations.
9. Continue automatically. Pause only when evidence cannot settle a semantic
   ambiguity or when a destructive revision of prior work needs confirmation.

## Record what the source only asserts

Judge an assertion by its content, never by its marker word ("obviously", "it is
easy to verify", "similarly", "the proof is omitted", "left to the reader", "one
may conjecture"). First construct the real derivation, or find the one already in
the graph, then place it in one of three **tiers**:

| Tier | When | Graph |
| --- | --- | --- |
| High | the source deliberately omits a long argument that is hard to see intuitively | keep a memorisation derivation (tails: the terms of the statement; the frozen memorisation weight) **and** add the real derivation at its real cost |
| Mid-high | the claim is strongly intuitive but the omitted argument is long | one derivation with the concepts the real argument uses as tails, weight 3 |
| Actual | strongly intuitive and the argument really is short | one derivation with the real tails at its actual cost |

Examples from one textbook import: associativity of the matrix product was
motivated by composing substitutions but the double-sum exchange was left out, so
it is mid-high, 3; "multiplying a row multiplies the determinant" is read straight
off the defining formula, so it is actual, 1; uniqueness of the reduced row echelon
form, which the book only says "one may conjecture", is mid-high, 3, argued
through equal solution sets.

When the real derivation has the same tails and head as one already in the graph,
the source reuses that one (step 5): the learner pays for the argument that exists,
however briefly the source states the claim. Derivations with the same tails and
head are one derivation.

Some statements are argued even though the text looks terse, and get an ordinary
derivation at the argued weight:

- "similarly" when the given argument transfers verbatim;
- a general method demonstrated on a worked example (an example that shows only the
  answer is not an argument);
- a conclusion an earlier theorem gives directly, even when the source does not
  cite it.

When the source gives two arguments for one claim, both derivations enter the
graph, and the source's route counts only the main proof.

### Keep your supplements apart

A derivation you construct is not the source's. List it apart from the source's
derivations, in one of two groups:

- **Supplied, asserted**: the source states the claim and asks the learner to
  accept it here. Count it in the source's route. The mid-high and actual tiers
  above land here.
- **Supplied, gap**: the source silently relies on a claim it never states, such as
  "all maximal independent subsets have the same size" behind "the rank of a vector
  set". Model the claim honestly and leave the source's route broken there; do not
  count the supplement.

### Definitions motivated later

A definition given without motivation where it appears gets two derivations:

- a memorisation derivation, with the terms of the definition as tails;
- a motivated derivation, with the concepts that raise the motivation as tails, so
  a solver can rebuild a motivation-first teaching order.

When a later section of the source supplies the motivation, the motivated
derivation belongs to that section of the source's route. For example, the sign
(−1)^{i+j} of a cofactor is explained by the proof that moves an entry to the
corner. When the source never supplies it, mark the motivated derivation as your
addition. Motivation given in the same paragraph, right after the definition,
counts as motivation.

Motivation is a tail. When another source motivates the same definition from some
concept that its derivation lacks, propose adding that tail. When another source
makes the same unmotivated move, treat it the same way: a memorisation derivation
with its own terms, plus the motivated one. Both are revisions of earlier work;
confirm them first.

## Preserve meaning-bearing figures

During the existing complete-chapter read, make a lightweight figure pass. A
figure is meaning-bearing when omitting it damages an object's independent
understanding, a source-backed derivation, or fidelity to the source. Map each
such figure to the concept or derivation documents it actually supports. A
user-requested figure is required even when it is not otherwise essential.

For authorized readable material, prefer exact extraction or faithful cropping.
Do not crop labels, legends, connections, or context needed for interpretation.
Redraw only when the source asset is unavailable or unreadable, or when a new
representation has a clear teaching benefit; verify every reconstructed semantic
detail against the source instead of inventing from domain expectations.

Store each figure in every consuming object's directory and insert it as a
relative Markdown image with meaningful alt text and a visible caption/source.
Use raw HTML only when Markdown cannot provide a required capability. An HTML
comment, TODO, empty element, or unavailable-image note is not a figure. If a
required figure cannot be obtained faithfully, report that object as blocked
instead of inserting a placeholder and claiming the chapter complete.

At chapter completion, report imported assets and whether each was extracted,
cropped, or redrawn; report omitted decorative figures with reasons and all
blockers. Do not create a persistent figure inventory or a second whole-book
media pass.

## Enforce atomic concepts and short labels

Follow the `derivon-mindmap` model's atomic concepts and label handles. Source
headings and theorem statements are rarely usable labels: a heading often lists
several concepts, and a theorem statement is a proposition. Split a list into
points the source defines separately. Give a proposition the book's name for it,
or a coined handle, and put the statement in `data.description` and the
document's first sentence. When the book gives one name several definitions, each
is its own point under that name, told apart by description and qualifier. Resolve
every `validate` label advisory before the chapter is complete; acknowledge one
with `review-label` only for a reason the source supports.

## Revise earlier chapters carefully

New chapters may automatically add source-backed concepts, parallel routes,
provenance, or prose. Before renaming, deleting, splitting, removing an edge, or
rewiring prior objects, show the old structure, new source evidence, proposed
structure, and affected objects; wait for confirmation.

## Finish the source range

Run full validation and representative route queries. Report imported chapters,
concept identity decisions, parallel routes, uncertain claims, high-weight
atomicity reviews, acknowledged label advisories with their reasons, source/publication status, and every updated document. Do not
claim completion merely because every heading became a point.
