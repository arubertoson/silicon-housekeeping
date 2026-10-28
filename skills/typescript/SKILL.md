---
name: typescript
description: Use when writing, reviewing, debugging, or migrating TypeScript code. Follow a condensed adaptation of Google's TypeScript style guide and verify compatibility with the project's compiler, runtime, module system, and host APIs.
---

# TypeScript Development

Prefer readable TypeScript with precise data models, explicit ownership, and
visible failure policy. Do not assume type checking establishes runtime support.

## Workflow

1. Identify the compiler version, configuration, runtime or host, module system,
   and tooling from repository instructions and existing code. If the target is
   unclear, ask before introducing version-specific syntax or APIs.
2. Read `references/style-guide.md` completely before writing or reviewing
   TypeScript. It separates Google-derived rules and examples from explicit
   local exceptions and engineering guidance. Preserve the distinction between
   requirements, preferences, and permitted alternatives.
3. Apply the relevant rules to the task, not as a whole-project migration.
   Repository conventions, formatter configuration, and required framework or
   host contracts take precedence. Preserve observable behavior and identify any
   intentionally changed contracts.
4. Verify unfamiliar APIs and run the relevant existing checks as described
   below. Review runtime behavior and ownership, not just type correctness.

Use the application-design and testing-styleguide skills for their broader
principles where relevant. Consult the linked upstream guide for unresolved
details, rather than loading it for every routine change.

## Checking runtime and library APIs

Before introducing an unfamiliar or version-sensitive API, verify it against the
project's installed declarations, library source, or target runtime and host
documentation. Check the actual compiler configuration and execution path for
module resolution, import extensions, and runtime TypeScript support. Report
unavailable verification rather than guessing.

Declarations describe an API but do not prove that the runtime provides it.
Node.js, browsers, and embedded hosts have different globals and capabilities;
transpilation or type stripping does not supply missing APIs. Avoid compatibility
shims unless support for multiple targets is an actual project requirement.

## Validating changes

Run the project's documented formatting, type-checking, build, and test commands
relevant to the change. Respect existing compiler, formatter, linter, and test-
runner configuration rather than adding tools or changing policy unprompted.

Validate with the supported runtime or host. Type checking and syntax checks do
not establish runtime behavior, resource cleanup, or integration compatibility.
State any checks that could not be run.
