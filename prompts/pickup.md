---
description: Continue a Beads issue from its current state without loading session history
argument-hint: "<issue-id> [steering]"
---
Continue work on Beads issue `$1`.

Additional steering from the user:
${@:2}

- If no issue ID was supplied, ask for one and stop. Follow the Beads skill and repository instructions.
- Check the active Beads workspace. If missing or the issue cannot be found, ask for the correct workspace or ID. Do not initialize a workspace or substitute a different issue.
- Read `bd show <id>`, including its current description, acceptance criteria, design, notes, and continuation checkpoint. Treat these as the starting state, not as proof that the working tree still matches it.
- Load only relevant parent constraints, active blockers, and source files needed for the immediate next action. Do not load the whole backlog, all comments, or old session transcripts. Retrieve history only to resolve a specific consequential gap.
- Check relevant repository/working-tree state before editing. Preserve existing work. Distinguish recorded verification from fresh verification; do not assume a past passing check proves the present tree passes.
- If the issue is closed, superseded, blocked, or owned by another worker, explain and resolve that condition before implementation. Do not automatically reopen, take over, or switch to a replacement issue. Reading or resuming does not authorize claiming or changing task records; leave ownership and status unchanged unless explicitly requested.
- Reconcile additional steering with the saved state. Ask only when a consequential conflict or missing decision prevents safe continuation. Do not reopen settled decisions or revive abandoned work without a concrete reason.
- Preserve the selected implementation or coaching role and any pending review. Test approval applies only to the behavior or increment explicitly approved, not all future work. If invoked alone, default to implementation; use the caller-first approach in the `application-design` skill.
- Briefly state the current goal and immediate next action, then proceed with that action within the saved boundaries. If paused for review or approval, remain paused. Resume at most one reviewable increment, not the whole task. No retrospective session summary.
