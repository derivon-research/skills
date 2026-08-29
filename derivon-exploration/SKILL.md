---
name: derivon-exploration
description: Explore an unfamiliar subject with a learner through an evidence-backed explain, verify, update, and next-question loop that grows a personal Derivon Mindmap. Use when the user is learning through conversation and cannot serve as the domain authority.
---

# Derivon Exploration

Use `derivon-cli` and `derivon-mindmap` with this skill. This is Agent-led
knowledge exploration with a learner, not expert-approved graph creation and not
a read-only teaching exam. The workspace is a personal learning graph; observed
learning effort may calibrate its weights.

Do not create a session file. Resume by reading the graph and asking the user
which question to continue from.

## Run the exploration loop

### 1. Analyze the question

On the first question, identify necessary concepts and genuine relationships,
initialize an empty Mindmap workspace if needed, and create the smallest useful
initial graph. Prefer a real empty-tail entrance when a foundational concept is
learnable without graph prerequisites; never force a fake start point or confuse
an empty tail with the user's query start set.

On later questions, continue the same workspace and first connect the question to
existing concepts. Ask before starting a separate workspace for an unrelated
subject.

### 2. Explain from evidence

Prefer user-provided material. Otherwise research textbooks, standards, papers,
or official documentation. Record concise source locations, scope, and
uncertainty in every inserted object document. Keep source conflicts explicit.

Explain the user's question. Add a new concept promptly when it becomes necessary
because the Agent introduced it for explanation or the user mentioned it without
demonstrated understanding. Do not add concepts merely because they were named.
Do not encode chapter adjacency, citation, chronology, or similarity as a
hyperedge.

### 3. Verify usable understanding

Ask the learner to discriminate concepts, solve a case, predict behavior, test a
boundary, transfer the idea, or imagine a real application. Do not ask them to
repeat the explanation. If the answer fails, locate the gap, explain differently,
and test with a different task.

### 4. Update after evidence

After at least one non-recall task demonstrates understanding, atomically update
points, genuine derivations, documents, and personal weights. Use observed effort
to revise marginal whole-step costs and record whether a weight is observed or
provisional. If understanding remains incomplete, repair prerequisites,
explanation, examples, or cost instead of pretending completion.

Non-destructive verified updates need no redundant approval. Deletion or broad
restructuring still requires an impact summary and confirmation. Render,
validate, and report every changed document. If static material proves
insufficient during actual learning, or the user requests richer content, use the
central `derivon-mindmap` rich-document contract. Prompt the user to open any new
interactive example.

### 5. Offer valuable next questions

Inspect points that are not tails of any hyperedge. Choose two or three anchors
and propose real questions based on:

- relevance to the learner's original goal or interests;
- transfer across contexts;
- likely downstream concepts or problems unlocked;
- practical application or explanatory power;
- authoritative-source availability;
- lower expected derivation cost when value is otherwise comparable.

State each question's value and rough exploration cost. Start from valuable
questions, not a concept the Agent wants to lecture next. Do not create candidate
points or edges during recommendation.

### 6. Continue

The user selects a question; return to analysis in the same graph. The Loop ends
when the user stops, evidence is unavailable, or a new workspace is explicitly
chosen.

## Enforce concept boundaries

Treat Chinese `与`, `和`, `、`, English `and`, and list coordination as mandatory
atomicity review signals. Split independently definable, learnable, derivable, or
reusable parts. A conjunction is allowed only for one intrinsically unified
concept supported by evidence.
