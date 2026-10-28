---
name: typescript
description: Use when writing, reviewing, debugging, or migrating TypeScript code. Follow TypeScript style guidance and verify compatibility with the project's compiler, runtime, module system, and host APIs.
---

# TypeScript Development

Prefer readable TypeScript with precise data models, explicit ownership, and
visible failure policy. Do not assume type checking establishes runtime support.

## Writing and reviewing code

Read `references/style-guide.md` completely before writing or reviewing
TypeScript code. Existing project conventions take precedence over this guide.
Formatting belongs to the project's formatter configuration, not this skill. Use
the application-design and testing-styleguide skills for their broader principles
where relevant.

Identify the compiler version, TypeScript configuration, runtime or host, module
system, and tooling from repository instructions, configuration, and existing
code. If the target is unclear, ask before introducing version-specific syntax
or APIs.

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
