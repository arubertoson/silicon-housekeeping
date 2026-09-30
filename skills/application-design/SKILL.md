---
name: application-design
description: General application design principles. Use when designing, structuring, or materially refactoring application code.
---

# Application Design

Prefer simple, explicit software whose structure reflects what it actually does.

Start concrete and flat. Model important concepts as data, keep execution
straightforward, and let structure and abstractions emerge from demonstrated
needs rather than predicted ones.

## Let Structure Emerge

Start with the simplest structure that fits the code you have.

* Keep related code together.
* Do not create directories, packages, or layers for concepts that do not yet
  exist.
* Group code when a clear concept has emerged and doing so improves locality or
  navigation.
* When grouping becomes useful, prefer behavior or capability over technical
  role.
* Do not reorganize code merely to make it resemble a known architecture.

Architecture should reflect what the implementation has revealed.

## Model Data Explicitly

Use descriptive data structures to make important concepts visible.

* Give meaningful shape to requests, results, configuration, state, events, and
  other application concepts.
* Prefer explicit data over loose dictionaries, positional tuples, implicit
  state, or object graphs that hide meaning.
* Prefer immutable data when mutation is not part of the concept.
* Do not introduce a data type merely to wrap unrelated parameters.

Data structures should explain the model, not merely carry values.

## Keep Execution Straightforward

Prefer behavior that can be followed directly.

* Prefer explicit calls and data flow over indirection.
* Keep side effects and external interactions at clear boundaries.
* Prefer composition over inheritance.
* Do not introduce polymorphism solely to replace straightforward control flow.
* Keep related decisions together when splitting them would obscure the behavior.

The reader should be able to follow what the application does without
reconstructing it across unnecessary layers.

## Abstractions Must Earn Their Place

Introduce abstractions in response to concrete pressure, not hypothetical future
needs.

* Abstract when doing so names a real concept or boundary.
* Extract genuinely shared behavior when the duplication has become meaningful.
* Use an abstraction when it materially improves understanding or ownership.
* Do not add repositories, services, factories, adapters, interfaces, or similar
  patterns merely because an architecture or pattern contains them.
* Prefer a little duplication to the wrong abstraction.

An abstraction should explain the system better than the concrete code it
replaces.

## Respect Real Boundaries

External systems create meaningful boundaries. Architectural layers do not
automatically do so.

Databases, filesystems, APIs, queues, processes, and similar systems may justify
adapters or shared infrastructure when there is a concrete need.

Do not force application code into `domain`, `application`, `infrastructure`,
`repositories`, or similar layers unless those distinctions have become useful
concepts in the software itself.

Boundaries should come from the system, not from the diagram.

## Prefer Locality

Code that changes together should usually live together.

* Prefer locally coherent implementations over globally uniform abstractions.
* Follow established local structure when modifying existing code.
* Do not reshape a subsystem solely to conform to these guidelines.
* Introduce broader structure only when the existing locality has become harder
  to understand.

Keep the behavior that matters close enough to reason about as a whole.
