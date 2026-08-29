---
name: derivon-creation
description: Create or improve a Derivon knowledge graph with a domain-knowledgeable user through dependency-ordered grilling, adversarial graph review, confirmed batches, and atomic writes. Use when the user can decide domain semantics and wants the Agent to structure that expertise.
---

# Derivon Creation

Use `derivon-cli` and `derivon-mindmap` with this skill. The user is the domain
semantic authority. The Agent researches external facts, maps decisions, tests
the graph model, and writes only after one bounded batch reaches shared
understanding.

## Build a design tree

Every concept identity, prerequisite claim, alternative route, weight comparison,
and unsupported relation type is a decision node. Work in rounds. The frontier is
every semantic decision whose prerequisites are settled; ask the complete current
frontier with numbered questions and a recommended answer. Wait for the user's
answers, reshape the tree, and repeat.

Find filesystem, source, schema, and CLI facts yourself. Ask the user for domain
decisions, not facts an Agent can verify.

## Run one creation batch

1. Freeze target audience, purpose, source authority, graph region, point
   granularity, and new/existing workspace boundary.
2. Interview the expert frontier about concept identities, exact scopes, joint
   premises, one-step conclusions, alternatives, and useful non-derivational
   evidence.
3. Produce a candidate batch of points, atomic hyperedges, audience-calibrated
   weights, provenance, and independently useful object documents. Do not write.
4. Adversarially review:
   - coordinated/bundled concepts;
   - unused or missing tails;
   - chapter order, chronology, similarity, or citation disguised as derivation;
   - hidden reusable intermediates;
   - alternative routes merged incorrectly as AND;
   - cycles, empty tails, parallel edges, and weight comparisons;
   - definitions or derivation documents that assume their conclusion.
5. Show the semantic batch summary. When the frontier is empty, explicitly ask
   the user to confirm shared understanding and authorize this batch.
6. Apply with `derivon apply` and atomic manifest replacement, create/update
   documents, render, validate, and report exact graph and document changes.
7. Audit routes, isolated points, points not used as tails, unresolved identities,
   and evidence that needs a separate relation layer. Propose but do not write the
   next batch.

## Keep concepts atomic

Chinese `与`, `和`, `、`, English `and`, and other coordination force review. If
parts can be understood, reused, derived, or referenced independently, split them
and re-evaluate every incident edge. A source heading and a shorter label do not
prove atomic identity.

## Use the document surface

Preserve source fidelity and the owning object's graph role. Rich media is not a
creation-batch completion gate. When the user requests rich or interactive
content, follow the central `derivon-mindmap` rich-document contract and never add
decorative interaction. After writing, name every updated document and prompt the
user to view any new interactive example.
