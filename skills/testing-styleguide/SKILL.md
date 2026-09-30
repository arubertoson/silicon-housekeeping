---
name: testing-styleguide
description: General testing principles and conventions. Use when writing, reviewing, or modifying tests.
---

# Testing Style Guide

Test observable behavior for confidence, not test counts or coverage targets.

Prefer the highest useful level of testing that remains fast, deterministic, and
easy to understand. Do not repeat the same behavior at every layer simply because
multiple layers exist.

## Test at Meaningful Boundaries

* Prefer integration tests through public application or service boundaries.
* Use real local dependencies when practical, such as databases, filesystems,
  parsers, and other deterministic components.
* Keep representative end-to-end tests for important user journeys.
* Do not test implementation details when the same behavior can be verified
  through a public boundary.
* Add focused unit tests when logic is complex enough that exercising it through
  a larger boundary would make failures harder to understand.

A useful test should make it clear what behavior failed, not merely which private
function changed.

## Test Risk, Not Structure

Add tests for behavior that is important, subtle, easy to break, or previously
broken.

* Add regression tests for real defects.
* Test important edge cases and failure paths.
* Fuzz parsers, state transitions, and other input-heavy logic when the input
  space warrants it.
* Do not mirror every function or class with a corresponding test merely because
  it exists.
* Do not write tests whose main purpose is increasing coverage.

A few well-chosen tests are preferable to a large suite of low-value assertions.

## Prefer Real Behavior

Test against the real thing whenever doing so is practical.

For local and deterministic dependencies, prefer using the actual implementation
rather than replacing it with a test double. For external systems, prefer a real
integration test when it is reliable, inexpensive, and appropriate to run.

When a live external dependency is too slow, expensive, unreliable, or
credential-dependent, recorded real data is usually preferable to a hand-written
mock.

Fixtures captured from real systems should preserve enough provenance to
understand what they represent, such as the source, relevant API or schema
version, and when they were captured. Refresh them when the external contract
changes or when there is reason to believe the fixture no longer represents
current behavior.

Where practical, exercise recorded fixtures through the same parsing and
conversion path used for live responses rather than constructing internal
objects that bypass the integration boundary.

## Avoid Mocks Where Possible

Mocks test our model of another component's behavior. When that model is wrong,
the test can pass while the real system fails.

Prefer, in order of suitability:

* real implementations;
* representative fixtures captured from real behavior;
* small purpose-built fakes;
* mocks when the alternatives are impractical.

Mocks are appropriate when interaction itself is the behavior being tested, or
when reproducing the dependency any other way would be disproportionately
expensive or difficult.

Avoid mocking internal collaborators merely to isolate every class or function.
Avoid tests whose primary assertion is that a sequence of mocked calls occurred
unless that interaction is itself part of the contract.

The goal is not to eliminate test doubles. It is to avoid gaining confidence
from a simulation that only confirms assumptions we wrote ourselves.

## Keep Tests Deterministic

Default tests should be:

* deterministic;
* fast enough to run frequently;
* isolated from developer state;
* credential-free;
* offline.

Control time, randomness, filesystem locations, and other environmental inputs
when they affect behavior.

Tests that depend on live providers or external services should be explicit,
opt-in smoke or integration tests rather than part of the default suite.

## Keep Tests Clear

* Arrange test data so the scenario is easy to understand.
* Assert the behavior that matters and avoid unrelated assertions.
* Prefer descriptive scenarios over clever test infrastructure.
* Share test helpers when they remove meaningful repetition, but do not build a
  testing framework inside the test suite.
* Keep setup close to the test when moving it elsewhere would hide what the
  scenario depends on.

Test code should follow the same rule as production code: abstractions must earn
their place.
