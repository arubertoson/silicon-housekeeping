---
description: Optionally record agreed outcomes as Beads tasks, not an implementation plan
argument-hint: "<parent-id>"
---
Record independently useful outcomes from our agreed design as child Beads tasks under `$1`. This is optional tracking, not a prerequisite for implementation.

Load the `beads` skill, inspect the parent and existing children, and use only decisions actually agreed in this conversation. If the parent or agreement is unavailable, ask for the missing context. Reuse existing task coverage rather than creating duplicates.

Briefly state the outcomes worth tracking, then create the necessary tasks without a second approval. Each should describe its outcome, concrete acceptance criteria, relevant caller contract, and accepted constraints. Keep the parent's scope unchanged. If there is no useful independent split, say so and create nothing.

Do not turn every function, design review, test pass, or implementation increment into a task. Do not predict internal layers or write a detailed implementation plan. Increment boundaries will emerge from caller-first implementation and feedback. Add dependencies only where an outcome genuinely depends on another.

Report created IDs and suggested order briefly. This command authorizes only creating the agreed child tasks and necessary dependency links: do not claim or close tasks, edit existing issues, write code, or create duplicate planning documents.
