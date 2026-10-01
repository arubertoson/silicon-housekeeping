# Zig Style Guide

Prefer straightforward Zig whose ownership, lifetimes, and execution order are
visible. Keep related behavior together and make abstractions earn their place.

## Maintain an Ownership Model

A reader should be able to determine who owns a value, how long it lives, what
invalidates it, and what happens on failure without tracing every allocation.

* Distinguish borrowed dependencies, returned data, operation-local scratch, and
  external resources.
* Make allocation provenance explicit. Memory must be released through the
  allocator that actually allocated it, not merely an allocator passed nearby.
* State whether inputs are borrowed, copied, or consumed, and whether consumption
  happens on success only or also on failure.
* Document ownership transfer where it occurs. Scope cleanup so it stops applying
  once another owner takes responsibility.
* Do not confuse `const` access with ownership: a read-only slice can still refer
  to owned or borrowed memory.
* Avoid copying owning values as if they were independent owners. Document stable
  address requirements when callbacks or stored pointers depend on them.

Names such as `result_allocator` and `scratch` should reinforce distinct
lifetimes. Use a simple local name such as `alloc` when there is only one relevant
allocator and its role is clear.

## Allocate by Lifetime

Prefer arenas when a group of allocations naturally shares a lifetime. Choose
that lifetime first; do not introduce arenas merely to hide cleanup.

For command-oriented applications, a useful default is:

* The command owns an arena for returned data, keeping it alive through rendering
  and any downstream processing. Arena-backed data does not need per-field or
  per-result memory cleanup.
* An operation owns a local scratch arena for temporary allocations that must not
  survive the call.
* Long-lived components borrow dependencies rather than accumulating all
  operation allocations in a component-wide arena.

Nothing returned may refer to a destroyed scratch arena. Ensure lower-level APIs
actually allocate returned data into the intended result allocator; a database
connection's allocator, for example, need not have the result's lifetime.

Initialize local scratch arenas directly and defer their cleanup. Do not build
an arena-management abstraction unless repeated, concrete needs justify it.

* Use stack buffers for naturally bounded data when that keeps code simple.
* Use individually managed allocations when lifetimes differ or early release
  matters.
* Consider peak memory for large buffers and growing collections. Arena cleanup
  at scope exit does not make retained intermediate allocations free.
* If a result must own its lifetime independently, a result-owned arena can be
  appropriate. Make its single-owner cleanup contract explicit.
* Do not retain an allocator interface pointing into a local arena object that
  will move or go out of scope. Finish allocations before transferring an arena
  value, or provide a stable owner and obtain the interface from it.

Arenas manage memory, not external resources. Files, SQLite statements,
transactions, threads, and foreign-library objects still require their own
cleanup even when their associated memory is arena-backed.

## Keep Execution Local

Keep the steps of one operation close enough to reason about together.

* A long function is acceptable when it presents one coherent operation in order.
  Do not split functions merely to meet a length target.
* Use lexical scopes to bound temporary state and cleanup. Use labeled blocks
  when they make a local value-producing decision clearer than a separate helper.
* Extract helpers for meaningful concepts, shared behavior, resource boundaries,
  or ownership that becomes easier to understand independently.
* Avoid forwarding helpers and layers that only rename calls or hide sequencing.
* Keep validation, side effects, commit points, and compensating actions visibly
  related. Do not scatter a transaction's failure policy across incidental helpers.
* Prefer concrete parameter types when there is one supported implementation.
  Use `anytype` for genuine generic behavior, not to avoid naming a dependency.
* Introduce request, result, and state structs when they describe real concepts,
  not just to reduce parameter counts.

## Handle Errors According to Policy

Propagate with `try` unless the current scope can meaningfully recover, translate,
isolate, or finally report the failure.

Every `catch` should make the response clear: fallback, bounded retry,
translation, log-and-continue, or cleanup-and-return.

* Treat failures that prevent an operation's promise from being met as failures.
  Do not turn persistence failures into successful empty results.
* Continue only when a valid usable state remains. Explain non-obvious fallback
  choices and why best-effort work is allowed to fail.
* Translate errors at meaningful boundaries when callers need domain-specific
  distinctions. Preserve distinctions needed for recovery or diagnosis.
* Prefer inferred error sets for straightforward internal propagation. Use named
  error sets when a deliberate contract helps callers; do not flatten everything
  into a generic failure or default to `anyerror` unnecessarily.
* Report a propagated failure where it is finally handled, rather than logging
  it at every layer. Include the operation and useful context, without exposing
  secrets or sensitive content.
* Use `catch {}` only for understood, harmless failures. Make the justification
  apparent; silence must not hide a broken invariant or failed persistence.
* Use assertions and `unreachable` for programmer invariants, not recoverable
  failures caused by input, the filesystem, or external systems.

A best-effort UI notification and a database commit have different correctness
requirements. Choose policy from the operation's contract, not from a uniform
rule that all failures should abort or all failures should be logged and ignored.

## Make Cleanup and Failure Ordering Visible

Place `defer` or `errdefer` immediately after successful resource acquisition.

* Use `defer` for scope-owned resources and `errdefer` for resources transferred
  on success.
* Use scopes to make ownership transitions precise. An earlier `errdefer` must
  not destroy a resource already transferred if a later step fails.
* Remember that defers execute in reverse order. Close users of memory before
  releasing the memory they depend on.
* Distinguish memory cleanup from rollback and compensating side effects. An
  arena does not undo a published file or a database write.
* Decide how cleanup failure affects the primary error. Do not accidentally
  replace the original failure with a secondary cleanup failure.
* Handle uncertain outcomes conservatively. A failed commit does not necessarily
  justify deleting data that a committed record might reference.

## Document the Mental Model

Ownership and lifetime documentation is part of the API, not optional decoration.
Do not avoid useful comments merely because the code is otherwise straightforward.

* Use `//!` to explain a module's purpose, responsibilities, and shared ownership
  model.
* Use `///` for caller-facing contracts and fields whose ownership, validity,
  threading, or invariants are not evident from their types.
* Public allocating operations should identify the owner and lifetime of returned
  data and whether the caller must perform cleanup.
* Use `//` beside implementation decisions: ordering constraints, ownership
  transfers, fallback behavior, and reasons an apparently simpler approach is
  unsafe.
* Explain why and under what conditions, rather than mechanically restating
  each statement.
* Keep documentation accurate as implementation changes. A misleading lifetime
  comment is worse than a missing one.

## Give Code Room to Be Read

Use `zig fmt` as the formatting authority. Within that format, organize code for
scanning rather than minimum line count.

* Separate meaningful phases with a blank line. Add a short phase comment when
  intent or ordering would otherwise be unclear.
* Expand dense conditionals, SQL bindings, struct construction, and signatures
  when packing them together obscures decisions or field correspondence.
* Keep acquisition and cleanup adjacent rather than separating them for visual
  symmetry.
* Group declarations and related operations coherently; do not impose a rigid
  file-size limit or reorganize working code for cosmetic uniformity.

## Validate Lifetime and Failure Contracts

Use allocator-aware tests for in-process ownership and real isolated resources
for integration behavior.

* Back test arenas with `std.testing.allocator` and always deinitialize them.
* Exercise important partial-initialization and allocation-failure paths when
  ownership transfer or cleanup is subtle.
* Check behavior after an operation's scratch lifetime ends, not only while its
  temporary state is still alive.
* Test persistence guarantees and failure outcomes, not merely that allocations
  were released. Leak-free code can still delete the wrong blob or report an
  uncommitted operation as successful.

Run the repository's documented formatting, build, and test commands for code
changes. Do not substitute a generic Zig command for project-specific validation.
