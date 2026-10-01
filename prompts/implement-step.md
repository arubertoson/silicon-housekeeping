---
description: Confirm the outcome, then implement from the caller inward
argument-hint: "[task-id]"
---
Prepare to implement the work discussed in this conversation. Optional Beads task: $ARGUMENTS

Before implementation, inspect the conversation and, as needed, relevant repository instructions, code, working-copy state, and task context. Then give me a short outcome brief: the result we believe we're aiming for, the first useful increment, and any important assumptions or unresolved ambiguity. Ask me to confirm or correct it, and stop. Do not edit files, run implementation checks, or begin implementation until I confirm. If the outcome is already explicit, still provide the brief and wait for confirmation.

After confirmation, implement the confirmed work as follows:

Follow `application-design`, relevant language skills, and repository instructions. Read the relevant code and working-copy state; preserve unrelated work. If a task ID is supplied, read the task and necessary parent context, but do not claim or update it. A task is not required. Use the conversation for the current increment; do not create progress documents or duplicate task notes.

${VCS_LOG}

Keep the confirmed outcome in view: what result should the caller receive or make observable? Work from that caller inward. Let its usage establish the inputs and results of supporting operations. Introduce code because the caller demonstrates a need, not because a layer or abstraction might be useful later. Trust settled requirements, inspect repository-answerable questions, and make reasonable implementation decisions without asking me to design every detail.

Choose the next increment for useful design feedback. Make enough concrete code visible to evaluate what calls what, in which order, how data flows, where responsibilities belong, and how naturally it reads. Do not fill in several layers before exposing the calling code. A complete end-to-end path is not required for every increment; neither is an arbitrary file count or a helper-sized change. Mark unfinished operations honestly, keep them out of active paths where necessary, and never make placeholders appear to work. Avoid unrelated refactoring.

Inspect the diff and run required existing checks. Until I explicitly accept the code's shape or request tests, do not write tests, fixtures, mocks, scaffolding, or detailed test plans. "Continue" alone is not test approval. Shape acceptance or a test request applies to the identified behavior or increment, not automatically to later work. Once shape is accepted, recommend testing the accepted behavior before piling on more implementation. Respect repository validation requirements; surface a genuine instruction conflict rather than silently bypassing it.

Report briefly in plain language: the outcome we are working toward, what this increment contributes, and what remains unfinished. Include a small call/data-flow sketch of the relevant code, labeling unimplemented operations. Point to the specific caller or diff worth reviewing and explain the design choice it exposes. Report checks accurately, recommend one next step, and wait for feedback. On continuation, build on that feedback and the existing code rather than restarting. Ask only when no useful progress is safe without my decision.

Do not mutate Beads records, create handoff documents, commit, push, or open a PR unless explicitly requested. Tracker work and checkpoints are separate, deliberate operations.
