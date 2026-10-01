---
name: zig-styleguide
description: Use when writing, reviewing, debugging, or migrating Zig code. Follow Zig style guidance and verify standard-library APIs against the compiler used for the task.
---

# Zig Development

Use this skill for Zig implementation and review. Do not assume the newest Zig
version is the one relevant to the code.

## Writing and reviewing code

Read `references/style-guide.md` before writing or reviewing Zig code. Apply its
guidance alongside the conventions evident in the code being changed. Use the
application-design and testing-styleguide skills for their broader principles
where relevant.

## Using the standard library

Before introducing a standard-library API that is not already used in the
project, call `zig-stdlib-search` to check its API and implementation in the
available compiler's standard library. Also call it when behavior is uncertain,
when remembered usage may come from another Zig version, and during version
migrations. For migration work, ensure the project's selected compiler is the
intended target before treating search results as authoritative.

Search using focused identifiers or terms. Read the relevant implementation and
documentation comments in the returned matches before relying on them. The tool
reports which Zig version it searched; do not treat results as evidence for
other compiler versions.

If `zig-stdlib-search` fails or is unavailable, report that limitation. Do not
guess from memory or silently substitute another search method.

## Validating changes

Run the project's documented formatting, build, and test commands relevant to
the change. Compilation and tests against the project's compiler are the final
check; a standard-library search does not replace validation.
