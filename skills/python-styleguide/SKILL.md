---
name: python-styleguide
description: Python design and implementation conventions. Use when writing or modifying Python source code.
---

# Python Style Guide

Prefer idiomatic, explicit Python with descriptive types and data structures.
Favor straightforward code, locality, and restrained abstraction.

When modifying existing code, local conventions take precedence over this guide.

## Data Models

Use dataclasses for meaningful structured application data such as descriptors,
requests, results, configuration, and state.

Prefer `frozen=True` when mutation is not part of the model.

Group values into a dataclass when they describe one concept, not merely to
shorten a function signature. Prefer structured results over unexplained tuples
or dictionaries when the returned values form a meaningful concept.

For example:

```python
@dataclass(frozen=True)
class SearchRequest:
    query: str
    location: str | None
    remote_only: bool


def search_jobs(request: SearchRequest) -> list[Job]:
    ...
```

The value of `SearchRequest` is that it names and describes a concept, not that
it reduces the number of function parameters.

## Types

* Type all parameters and return values.
* Use `from __future__ import annotations`.
* Use `Type | None` instead of `Optional[Type]`.
* Use the `T` suffix for type variables.
* Prefer read-only abstractions such as `Mapping` for inputs that are not
  mutated.
* Prefer precise types over `Any`.
* Do not distort runtime code solely to satisfy a type checker.

Use narrow, targeted suppressions for known invariants that the type system
cannot express cleanly. Do not use ignores to hide genuine uncertainty.

Internal helpers may remain private when intentionally reused across internal
modules. Prefer a targeted suppression such as:

```python
# pyright: ignore[reportPrivateUsage]
```

over making implementation details public solely to satisfy tooling.

## Functions and APIs

* Make function signatures descriptive and easy to understand at the call site.
* Use keyword-only arguments for optional or configuration-style parameters when
  that improves clarity.
* Avoid positional booleans.
* Avoid `**kwargs` unless forwarding, compatibility, or extensibility genuinely
  requires it.
* Avoid shadowing Python built-ins.
* Prefer explicit dependencies over hidden global state.

For enum-like public options, accepting documented string literals alongside an
enum is appropriate when it improves caller ergonomics:

```python
def create_agent(
    config: AgentConfig,
    *,
    tool_mode: Literal["auto", "required", "none"] | ChatToolMode = "auto",
) -> Agent:
    if isinstance(tool_mode, str):
        tool_mode = ChatToolMode(tool_mode)

    ...
```

Use this when strings are intentionally part of the public API, not merely to
avoid imports internally.

## Exceptions

Raise where a failure is detected; catch only to recover, translate, or report
at an application boundary. Otherwise, let it propagate.

* Raise for broken contracts; return ordinary values for expected outcomes.
  Never disguise failures as empty results.
* Prefer standard exceptions; add custom `Exception` subclasses only when callers
  need to distinguish failures.
* Catch specific exceptions around the smallest possible `try` block.
  Prefer attempting operations over race-prone prechecks.
* Translate at abstraction boundaries with `raise AppError(...) from exc`;
  use bare `raise` to re-raise.
* Use context managers or `finally` for cleanup. Suppress only understood,
  harmless failures; retry only when safe and bounded.
* Report failures once, where finally handled. Reserve broad catches for isolation
  boundaries; preserve interruption, exit, and cancellation.

Handling should clarify failure policy, not hide defects. If a handler adds no
meaningful response, omit it.

## Docstrings

Use Google-style docstrings for public APIs.

```python
def equal(arg1: str, arg2: str) -> bool:
    """Compare two strings.

    Args:
        arg1: The first string to compare.
        arg2: The second string to compare.

    Returns:
        Whether the strings are equal.

    Raises:
        ValueError: If either string is empty.
    """
```

* Document intent, behavior, constraints, and information useful to callers.
* Do not restate information already obvious from the signature.
* Document application-specific exceptions.
* Document standard Python exceptions only when their conditions are non-obvious.

## Public Exports

For package-level public APIs in `__init__.py`:

* use direct re-exports;
* define explicit `__all__`;
* avoid wildcard imports and unnecessary identity aliases.

Do not define `__all__` in ordinary internal modules unless the module is
intentionally a public import surface.

Do not expose private implementation solely to satisfy tooling.

## Performance

* Avoid redundant parsing, serialization, allocation, and expensive computation.
* Cache expensive deterministic work when reuse is expected.
* Compute once and reuse when practical.
* Do not complicate clear code for speculative performance improvements.
* Measure performance concerns when they would materially affect the design.
