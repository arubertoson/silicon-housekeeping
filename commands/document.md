---
description: Add documentation and type annotations to code
argument-hint: "[files/scope]"
---
Add documentation and type annotations to the provided code.

User-provided files/scope:
$ARGUMENTS

Process:
- Identify the language and version, then infer its idiomatic doc format (JSDoc, docstrings, GoDoc, rustdoc, etc.).
- Scope to $ARGUMENTS if provided, otherwise to what was explicitly shared. Do not pull in other files from context.
- Propose a plan before making changes: files/functions to document, doc format, and any ambiguities (missing types, unclear intent). Ask for confirmation unless the user requested none.
- Do not alter logic, rename identifiers, or refactor structure.

Type annotations:
- Annotate all parameters, return types, and class fields with the most specific type possible.
- Avoid `any`, `object`, or unparameterized generics.
- Define a type alias or interface for any complex shape used more than once.
- Use the language’s idiomatic type/documentation format.
- Keep type declarations focused on types and names; avoid long inline descriptions inside type/member declarations.
- For structured data, document the structure’s purpose once, then explain only members whose meaning, units, indexing, nil/null behavior, defaults, constraints, or lifecycle are non-obvious.
- Do not document obvious members where the name and type are sufficient.

Doc comments:
- Write module-level documentation, explaining the purpose and scope of the file.
- Write one for every function, method, and class.
- First line starts with a verb — what it does, not how.
- Optimize for readability over exhaustiveness.
- Do not restate what the type signature already expresses.
- Document intent, constraints, side effects, lifecycle, error behavior, and non-obvious invariants.
- Use examples only for public APIs or behavior that is not obvious from the signature.

Inline comments:
- Only explain **why** — never narrate what the code does.
- Use them for: workarounds, non-obvious algorithms, magic values, or intentionally surprising code.
