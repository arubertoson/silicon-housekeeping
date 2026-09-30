---
description: Establish the outcome through concrete calling code and data flow
argument-hint: "[task-id or outcome]"
---
Work outside-in on the agreed outcome in this conversation. Additional context: $ARGUMENTS

Follow the `application-design` skill and repository instructions. If I supplied a Beads task, read it for context without changing it. Otherwise work from the conversation; a task is not required. Trust settled decisions. Resolve code questions by inspection and make reasonable local assumptions; ask only when a missing decision prevents a useful proposal.

Briefly state the result we want the caller to receive or make observable. Find the closest existing implementation, read its complete caller and the APIs it uses, and follow actual project conventions. Name the relevant reference with a file path; distinguish existing APIs from proposed ones.

Show one complete caller in its intended file and integration context: inputs, operation order, data passed between calls, result handling, and cleanup where relevant. For a non-function surface, show the equivalent concrete interaction. Let the desired outcome establish the supporting operations' contracts. Do not substitute a preparation step for the requested outcome or design the internals of every proposed call. For prerequisite work, use its immediate caller without expanding scope.

Include a compact call/data-flow sketch alongside the code. Show meaningful inputs and results, and important branches or external effects; label proposed calls. This is a disposable reading aid in the conversation, not a separate document to maintain.

Point out what to review: whether the caller reads naturally, what is called where and when, how data flows, and whether responsibilities belong there. Keep explanations plain and concrete. Present the proposal for feedback; this is design discussion only, not authorization to edit code or Beads records. After agreement, implementation can proceed with `/implement-step` or `/implement-coach`.
