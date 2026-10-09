# Lua Style Guide

Prefer idiomatic Lua whose data flow, state ownership, and execution order are
visible. Keep related behavior together and make abstractions earn their place.
Existing repository conventions take precedence over these defaults.

## Name Concepts Clearly

Use `snake_case` for locals, functions, fields, filenames, and module path
segments. Use `PascalCase` for named types or class-like tables and
`UPPER_SNAKE_CASE` for deliberate constants. These are naming conventions, not
runtime guarantees. Match external API names rather than renaming them solely
for style. Prefer descriptive names; `i`, `key`, and `value` are fine in small,
obvious scopes. Use `_` for intentionally unused values where tooling supports it.

## Organize Modules Around Responsibilities

Use local declarations by default. Accidental globals are defects; deliberate
host globals or public registries should have clear ownership.

For an ordinary module, a useful reading order is:

1. A short module-purpose comment when the responsibility is not obvious.
2. Local `require` bindings and related constants.
3. The export table, conventionally `local M = {}`.
4. Module-private state, only when the module genuinely owns it.
5. Local helpers near the operations that use them.
6. Public functions, grouped by responsibility.
7. A single `return M` at the end.

This is a scanning aid, not a rigid template. Returning a function or a meaningful
object directly is appropriate when that is the module's actual interface.
Do not shuffle declarations when doing so obscures dependencies or sequencing.

```lua
local M = {}

local function is_valid_name(name)
  return type(name) == "string" and name ~= ""
end

-- Return a greeting, or nil and a validation error.
function M.greet(name)
  if not is_valid_name(name) then
    return nil, "name must be a non-empty string"
  end

  return "Hello, " .. name
end

return M
```

* Bind dependencies with `local parser = require("app.parser")`. Avoid legacy
  `module(...)`, writes to `_G`, and ambient globals for ordinary module APIs.
* Export the intentional public surface only. Do not publish helpers just to
  make them easier to test.
* Keep import-time work cheap and unsurprising. Put resource acquisition,
  registrations, and other externally visible side effects behind explicit
  activation unless the project's entry-point contract requires otherwise.
* Remember that `require` caches returned modules in `package.loaded`. A returned
  mutable table and module-local state are normally shared by all consumers in
  that Lua state, not recreated per call.
* Prefer acyclic dependencies. Move genuinely shared concepts into a focused
  module rather than hiding dependency cycles with scattered lazy imports.
* Use lazy `require` for a real optional dependency or loading boundary, not as a
  universal pattern. Missing required dependencies should fail clearly.

Follow the project's package layout and `package.path` conventions. In a new
standalone project, use a namespaced source tree such as `src/app/` and a separate
`tests/` tree, with tooling configured to resolve it. Use `init.lua` when the
loader and package structure call for it, not as a compulsory wrapper. Neovim's
`lua/` and `plugin/` directories are host conventions, not generic Lua layout.

## Keep Execution Local

Keep the steps of one operation close enough to reason about together.

* A long function is acceptable when it presents one coherent operation in order.
  Extract helpers for meaningful concepts, shared behavior, or resource boundaries,
  not to meet a line-count target.
* Prefer early returns when they clarify preconditions and keep the main operation
  from being buried in nested branches.
* Prefer functions and plain tables to class frameworks, inheritance chains,
  forwarding wrappers, or metatables that merely disguise straightforward code.
* Introduce options, result, and state tables when they describe real concepts,
  not just to reduce parameter counts. Avoid positional booleans and unexplained
  multi-value results in public APIs.
* Keep dependencies explicit. Use closures or instance-owned state when callers
  need independent configurations or lifetimes; do not force them through a
  mutable module singleton.
* Use `local function helper(...)` for local functions. Explicitly forward-declare
  mutually dependent locals when necessary; a later local declaration is not
  visible to an earlier function body.
* Use `object:method(...)` only for APIs that take `self`; it passes the receiver
  as the first argument. Keep definitions and call sites consistent. Extracting
  a method does not bind its receiver.
* Be deliberate about closure captures. Long-lived callbacks can retain mutable
  state and resources; check that captured values remain valid when invoked.

## Make Table Contracts Explicit

Tables serve as records, sequences, and maps. Choose the role and preserve its
invariants rather than relying on accidental behavior.

* Use named fields for records, dense positive integer keys starting at 1 for
  sequences, and intentional keys for maps.
* Distinguish absent (`nil`) from false. Assigning `nil` removes a table entry;
  it cannot represent a stored null value without an explicit sentinel.
* Use `value == nil` when false is a valid value. `value or default` replaces both
  nil and false; 0 and the empty string are truthy in Lua.
* Use `#items` and `ipairs` only when the sequence contract is dense. `ipairs`
  stops at the first missing index; the length operator is not a reliable element
  count for sparse tables. Track a count when holes or nil values are meaningful.
* Use `pairs` for maps, without assuming iteration order. Sort keys or maintain a
  separate sequence when deterministic order is part of the contract.
* Do not structurally mutate a collection during iteration unless the operation's
  semantics are understood. For sequence deletion, reverse iteration or building
  a new sequence often makes the behavior clearer.
* Tables are references. Document whether an API borrows, mutates, copies, or
  retains an input and whether returned tables share internal state.
* Do not mistake a shallow copy for isolation of nested tables. Keep default
  configuration from being mutated through a caller's instance.
* Use metatables only for a concrete semantic need. Document non-obvious lookup,
  mutation, equality, and iteration behavior; avoid clever implicit interfaces.

Use LuaLS/EmmyLua-style annotations when the project uses them or when a public
contract benefits from tooling. Prefer precise parameter, return, record, and
optional-value descriptions over blanket `any`. Annotations are documentation,
not runtime enforcement; validate untrusted values at boundaries.

## Handle Errors According to Policy

Choose a failure convention at an API boundary and make it consistent.

* For expected recoverable failures, a documented `nil, err` or the host's usual
  result convention is appropriate. Preserve distinctions callers need for
  recovery. Do not turn failed persistence into successful empty results.
* Use `error` or `assert` for violated programmer contracts; handle ordinary
  invalid input and external failures according to the operation's public policy.
  Do not use `assert(io.open(...))` when callers are meant to recover from failure.
* Let thrown errors propagate unless the current scope can recover, translate,
  isolate, clean up, or finally report them.
* Use `pcall` or `xpcall` at deliberate protection boundaries, not around every
  function call. A protected call's success boolean reports whether an error was
  thrown, not whether a returned `nil, err` represents success.
* Remember that Lua error objects need not be strings. Preserve the original
  object or deliberately translate it; capture a traceback when diagnosis needs
  one and the runtime provides an appropriate facility.
* Every handler should reveal its policy: fallback, bounded safe retry,
  translation, cleanup-and-propagation, or report-and-continue. Do not swallow an
  exception or treat a failed required import as an absent optional dependency.
* Report a failure once, where it is finally handled, with useful operation
  context and without secrets. Keep the primary failure visible if cleanup fails.

Multiple return values are part of the contract. Assignment to too few variables
loses values; parenthesized calls yield a single value, and calls expand only in
specific expression positions. Be careful when forwarding results or wrapping
calls. When nil values must survive vararg packing, retain an explicit count and
use the target runtime's supported pack/unpack facilities.

## Make Resource Lifetimes Visible

Garbage collection manages Lua memory, not timely cleanup or rollback of external
resources. Make ownership explicit for files, sockets, processes, timers,
subscriptions, and foreign-library objects.

* Establish cleanup immediately after successful acquisition. Cover normal
  returns, thrown errors, partial initialization, and cancellation where relevant.
* Lua has no universal `finally` or `defer`. Use the host's supported resource
  pattern or a focused protected-call boundary when cleanup must run after an
  error. Lua 5.4 to-be-closed variables are an option only on a compatible target
  and for values that support the required closing protocol.
* Do not rely on finalizers for prompt release. Close resources explicitly and
  document whether repeated close or teardown is supported.
* Separate cleanup from rollback. Closing a handle does not undo a published
  file, a database write, or a registered callback.
* Give asynchronous work a clear owner and invalidation policy. Reject stale
  results and prevent callbacks from acting on closed or replaced state.

Avoid adding a generic resource framework unless repeated needs justify it.
Prefer the smallest visible structure that reliably implements the lifetime.

## Respect Runtime and Data Semantics

Verify language features and library APIs against every supported target.

* Lua 5.1, Lua 5.2–5.4, and LuaJIT differ. `_ENV`, integer arithmetic, bitwise
  syntax, `goto`, `table.unpack`, `table.pack`, `utf8`, and `<close>` are not
  universally available. LuaJIT's Lua 5.1 baseline does not imply either absence
  or presence of every later feature; check the documented implementation.
* Treat `vim`, `ngx`, `love`, `bit`, `ffi`, and similar facilities as host or runtime
  dependencies, not portable standard-library APIs.
* Lua strings are byte sequences. `#text` measures bytes, not Unicode characters
  or display width. Use an appropriate supported library when those distinctions
  matter.
* Lua patterns are not regular expressions. Escape pattern metacharacters for
  literal matching or use plain mode in `string.find` when appropriate.
* Do not assume all runtimes have the same integer representation or exact range.
  Check precision and overflow requirements at serialization and FFI boundaries.
* Never evaluate untrusted input with `load` or `loadstring`; parse data with a
  suitable data format. Host execution and shell APIs need their own input-safety
  policy as well.

## Document the Mental Model

Ownership and lifetime documentation is part of the API, not optional decoration.
Do not avoid useful comments merely because the code is otherwise straightforward.
Garbage collection does not explain who may mutate shared tables, how long a
retained reference remains valid, or who must release an external resource.

* Use a module-level comment to explain purpose, responsibilities, activation,
  and the shared ownership model.
* Document caller-facing contracts and fields whose mutation, validity,
  asynchronous use, or invariants are not evident from their names or annotations.
  Use the project's chosen LuaLS/EmmyLua annotations where they help describe the
  contract, and prose for obligations those annotations cannot express.
* Public operations returning shared state or external resources should identify
  the owner, validity lifetime, and whether the caller must perform cleanup.
  State whether inputs are borrowed, copied, mutated, or retained and what
  invalidates returned references or handles.
* Use `--` beside implementation decisions: ordering constraints, ownership
  transfers, compatibility choices, fallback behavior, and reasons an apparently
  simpler approach is unsafe.
* Explain why and under what conditions, rather than mechanically restating
  each statement. Document failure conventions and cleanup obligations where
  callers cannot infer them.
* Keep documentation accurate as implementation changes. A misleading lifetime
  comment is worse than a missing one.

## Give Code Room to Be Read

Leave mechanical formatting to the project's StyLua configuration. Organize code
for scanning and understanding, not minimum line count.

* Separate meaningful phases with a blank line. Add a short phase comment when
  intent or ordering would otherwise be unclear.
* Break up dense conditionals, argument lists, and table construction when they
  obscure decisions or field correspondence. Make intermediate concepts explicit
  where that helps a reader follow the operation.
* Keep acquisition and its cleanup policy adjacent rather than separating them
  for visual symmetry. Keep ownership transitions and failure handling close to
  the operations they govern.
* Group declarations and related operations coherently; do not impose a rigid
  file-size limit or reorganize working code for cosmetic uniformity.

## Validate Behavior, Not Just Syntax

Run the repository's documented formatting, linting, and test commands. Do not
substitute a preferred framework or generic command for project-specific checks.

* Test public behavior, important edge cases, and failure outcomes. Pay particular
  attention to nil versus false, empty versus sparse sequences, shared mutable
  defaults, and multi-value result handling when relevant to the change.
* Exercise cleanup and partial-failure paths when resources or state transitions
  are involved. Test repeated activation or teardown when the API permits it.
* Use the actual host for integration behavior and the supported runtime matrix
  for compatibility-sensitive changes.
* Keep tests outside reusable source directories. Avoid exporting implementation
  details or rewriting module caches solely to reach private helpers.
* Optimize measured hot paths, not hypothetical ones. Prefer reducing redundant
  parsing, allocation, and I/O over blanket global-local aliases or clever code.
