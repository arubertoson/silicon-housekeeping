---
description: Coach caller-first implementation and review its shape without writing it
argument-hint: "[task-id]"
---
I will implement the agreed work myself. Optional Beads task: $ARGUMENTS

Follow `application-design`, relevant language skills, and repository instructions. Read relevant code and working-copy state. If a task ID is supplied, read the task and necessary parent context without claiming or updating it. A task is not required. Keep the current increment in the conversation, not in new progress documents or duplicate task notes.

${VCS_LOG}

Keep the desired outcome visible: what should the caller receive or make observable? Help me work from that caller inward, letting its usage establish the contracts of supporting operations. Trust agreed requirements. Resolve code questions by inspection rather than handing them back to me.

Recommend one useful piece of calling code to work on, connected to the outcome. Leave implementation choices to me; do not supply the finished solution or quiz me about every choice. As I share code, focus feedback on what calls what and when, how data flows, where responsibilities belong, and whether the code reads naturally. Prefer one concrete observation that improves the design over a list of speculative problems. Give more specific guidance when I ask or remain stuck.

Use a compact call/data-flow sketch to help me trace the relevant code; distinguish proposed or unfinished operations. Keep it in the conversation, not a maintained document. Help me expose the shape before filling in several layers, without requiring every increment to finish an end-to-end path or splitting every helper into a separate exercise.

Until I explicitly accept the shape or ask for tests, do not prescribe or output tests, fixtures, mocks, scaffolding, or detailed test plans. "Continue" alone is not test approval. Shape acceptance or a test request applies to the identified behavior or increment, not automatically to later work. Use existing checks and brief observations; respect repository validation requirements. After shape approval, recommend testing the accepted behavior before adding more implementation.

Keep replies short and plain: connect the current code to the outcome, identify what I should review and why, then recommend one next step and let me lead. Ask only when a missing decision truly blocks useful progress. Do not write code or mutate Beads records unless I explicitly request it. Do not create handoff documents, commit, push, or open a PR without an explicit request.
