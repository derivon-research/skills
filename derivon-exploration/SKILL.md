---
name: derivon-exploration
description: Explore an unfamiliar subject with a learner through an evidence-backed explain, verify, update, and next-question loop that grows a personal Derivon Mindmap. Use when the user is learning through conversation and cannot serve as the domain authority.
---

# Derivon Exploration

Use `derivon-cli` and `derivon-mindmap` with this skill. This is Agent-led
knowledge exploration with a learner, not expert-approved graph creation and not
a read-only teaching exam. The workspace records source-grounded explored
knowledge; observed understanding calibrates its explanations, prerequisites,
and personal weights rather than controlling graph membership.

Do not create a session file. Resume by reading the graph and asking the user
which question to continue from.

## Run the exploration loop

### 1. Scope one concrete question

Treat a broad learning goal as workspace direction, not authorization to build a
roadmap-sized graph. For a new project, initialize the strict empty workspace if
needed, record the goal and audience, and identify the first valuable concrete
question with the learner. On later questions, connect the question to existing
concepts first. Ask before starting a separate workspace for an unrelated
subject.

A teaching batch answers one concrete question with the smallest useful group of
concepts and derivations. A response family may contain several distinct answers
to the same pressure when comparing them is necessary for the question; historical
periods, chapter outlines, and desired future routes are not batches.

### 2. Research the problem and responses

Prefer user-provided material. Otherwise research textbooks, standards, papers,
or official documentation. The Agent settles source, filesystem, schema, and CLI
facts because the learner is not the domain authority.

Identify the current concepts, the historical, logical, or pedagogical problem
pressure that makes them insufficient, and one identifiable resolving move for
each candidate response. Keep historical attribution separate from Agent-composed
logical or pedagogical reconstruction. Add a concept when the explanation needs
one reusable understanding state, not merely because a source or user names it.
Form a hyperedge only when its full tail set is jointly necessary to the problem
and response.

### 3. Publish and explain one teaching batch

Explain the question from the evidence and publish one bounded teaching batch
with provisional weights. Follow the central Mindmap object-document contract:
concept documents own statements and boundaries; derivation documents own the
problem-to-response account. A derivation exposes one problem pressure, performs
one resolving move, and establishes one head.

Prefer a real empty-tail entrance when its pressure can be understood from lived
experience or other knowledge outside the graph. An empty tail is not a fake
start point and remains distinct from the learner-known start set. Keep chapter
adjacency, citation, chronology, similarity, and ordinary association in prose or
a separate relation layer.

Crosslink exact changed objects, render, validate, and report every graph, source
publication, and inserted-reference change. Source-grounded content may be
published before the learner demonstrates understanding so its documents can do
the teaching; label every new weight provisional.

### 4. Verify usable understanding

Ask the learner to discriminate concepts, solve a case, predict behavior, test a
boundary, transfer the idea, or imagine a real application. Ask them to use the
new understanding rather than repeat the explanation. If the answer fails,
locate the gap, explain differently, and test with a different task.

### 5. Repair and calibrate from evidence

After at least one non-recall task, repair the concepts, prerequisites,
derivations, examples, or prose exposed by the learner's response. Use observed
effort to revise marginal whole-step costs and change a weight from provisional
to observed only when the evidence supports it. Incomplete understanding remains
learner evidence; it does not require deleting source-grounded graph content or
pretending mastery.

Non-destructive verified updates need no redundant approval. Deletion or broad
restructuring still requires an impact summary and confirmation. Crosslink,
render, validate, and report every changed graph object, source document,
publication, and inserted reference. If static material proves insufficient or
the learner requests richer content, use the Mindmap rich-document contract and
prompt them to open each new interactive example.

### 6. Offer valuable next questions

Inspect points that are not tails of any hyperedge. Choose two or three anchors
and propose real questions based on:

- relevance to the learner's original goal or interests;
- transfer across contexts;
- likely downstream concepts or problems unlocked;
- practical application or explanatory power;
- authoritative-source availability;
- lower expected derivation cost when value is otherwise comparable.

State each question's value and rough exploration cost. Start from valuable
questions, not a concept the Agent wants to lecture next. Candidate questions do
not create graph objects until selected.

The learner selects a question and the loop returns to scope. End when the learner
stops, evidence is unavailable, or a new workspace is explicitly chosen.

## Enforce atomic boundaries

Treat Chinese `与`, `和`, `、`, English `and`, and list coordination as mandatory
atomicity review signals. Split independently definable, learnable, derivable, or
reusable concepts. Split a derivation that contains multiple problem pressures or
resolving moves, exposing reusable intermediate results. A conjunction remains
only when evidence supports one intrinsically unified understanding state.
