# TypeScript Style Guide

Prefer human-readable control flow, precise data models, and explicit ownership.
Follow local project conventions before this guide. Check the actual TypeScript
configuration, runtime, and host API declarations rather than assuming defaults.

## Readability and Locality

* Use descriptive names for concepts, identities, resources, and intermediate
  values. Short names are fine in small, obvious callbacks.
* Put distinct operations on separate lines. Expand compound conditions and
  nested callbacks when that makes sequencing and failure paths easier to follow.
* Use early returns for rejected input and unavailable state; keep the successful
  path visible. Prefer ordinary branching over dense ternaries and clever chains.
* Extract a helper when it names a real operation, invariant, or boundary. Do not
  scatter a coherent decision across helpers merely to shorten a function.
* Keep changes scoped. A readability pass must not silently redesign workflows,
  strengthen validation, alter retry policy, or change timing and ordering.

## Types and Data Models

* Name meaningful request, result, identity, callback, and state shapes. Do not
  wrap unrelated arguments just to reduce a parameter count.
* Use discriminated unions for genuinely distinct states or outcomes. Do not
  invent a generic framework for a small concrete protocol.
* Type public APIs and meaningful internal boundaries explicitly, including
  return values. Let obvious local values and contextually typed callbacks infer.
* Prefer `unknown` to `any` for untrusted or unspecified values. Narrow with
  runtime checks before treating external data as application data.
* Treat JSON parsing as returning `unknown`. `as`, `satisfies`, and a generic
  parse signature do not validate data. Validate nested fields as well as the
  envelope; preserve the existing acceptance rules during a cleanup.
* A type predicate must establish every property it promises. Do not label a
  partial identity check as validation of the entire message.
* Use `import type` or inline `type` imports for types. Respect the project's
  module system, extension rules, and runtime TypeScript support.
* Prefer readonly inputs when mutation is not part of the contract. Readonly is
  compile-time protection, not runtime freezing or deep immutability.
* Avoid unexplained positional tuples, booleans, non-null assertions, and casts.
  If the type system cannot express an invariant, keep an assertion narrow and
  explain why it holds; never use it to hide uncertainty.
* Preserve the distinction between omitted fields, `undefined`, and `null` when
  the runtime or serialization contract depends on it.

## Boundaries and Ownership

* Keep filesystem, transport, process, host-UI, and persistence interactions at
  visible boundaries. Types describe data; they do not grant authority.
* Make the owner of sockets, timers, listeners, subscriptions, and pending
  promises clear. Show how completion, timeout, disconnect, and shutdown release
  resources and settle outstanding work.
* For asynchronous code, retain the relevant owner and generation/session
  identity across awaits. Preserve existing stale-result checks and ordering.
* Keep request acceptance distinct from completion. Correlate responses by
  identity, not arrival order; uncertain delivery is not permission to replay.
* Prefer explicit calls and dependencies over hidden orchestration. Add classes,
  adapters, or layers only when they clarify a demonstrated boundary.

## Failure Handling

* Throw where a broken contract is detected. Return ordinary values for expected
  outcomes only when the API defines them; do not disguise failure as success.
* Catch to recover, translate, isolate, or report. Use the smallest practical
  scope and preserve the original error when it is not handled.
* Catch values are unknown. Narrow `Error` and host error shapes before using
  fields; do not assume every thrown value is an `Error`.
* Use `finally` for mandatory cleanup. Keep shutdown idempotent where resources
  can be closed from several lifecycle paths.
* Await promises or deliberately hand them off with explicit rejection handling.
  `void` alone does not handle a rejected promise.
* Document intentionally swallowed failures and which boundary reports them.
  Retry only when safe and bounded; respect cancellation and delivery ambiguity.

## Comments and Verification

* Document intent, trust boundaries, invariants, ownership, and failure policy.
  Do not narrate statements or repeat types in comments.
* Use the project's existing compiler, formatter, and checks. Do not add tooling
  or dependencies solely to enforce this guide.
* Define the observable behavior to preserve before choosing checks. Review
  validation predicates, side-effect order, callback timing, and cleanup paths
  during refactors.
* Report exactly what was checked. Type checking, syntax checks, formatting, and
  whitespace checks are not proof of runtime behavior.
