---
description: Test the behavior of the current increment without expanding implementation
argument-hint: "[focus]"
---
Test the current implementation increment. Optional focus: $ARGUMENTS

This is explicit permission to work on tests for this increment, not blanket approval of every design proposal or permission to finish the task. Follow `testing-styleguide`, relevant language skills, and repository instructions. Read the current diff, relevant caller, and existing tests before adding anything. Preserve unrelated work.

Start from the outcome the caller is meant to deliver. Briefly identify which implemented behaviors need confidence: the useful result, important failures, and any subtle rule or real regression. Distinguish these from unfinished behavior. Choose the smallest useful set of tests, reusing existing coverage; do not mirror every helper or test hypothetical future functionality.

Test through the nearest meaningful caller boundary with real deterministic components where practical. Avoid tests coupled to internal call sequences and avoid building elaborate mocking infrastructure. If a test would lock in an unresolved design choice, explain that specific gap and test the settled behavior instead.

Default to implementation (step) mode unless the current conversation explicitly establishes coaching mode or I request coaching. In implementation mode, state the selected cases briefly and write and run them without another permission round. Fix local correctness defects they expose within the agreed behavior; if a fix requires changing the agreed caller contract or responsibilities, report it rather than redesigning silently. In coaching mode, recommend the cases and where to exercise them, then review my work; do not write code unless I ask.

Report what is now verified, which checks actually ran, and any meaningful gap. Point to the tests worth reviewing and recommend the next step. Do not expand feature scope, mutate Beads records, create progress documents, commit, push, or open a PR.
