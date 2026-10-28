# TypeScript Style Guide

A locally maintained adaptation of Google's
[TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html),
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
([upstream license](https://github.com/google/styleguide/blob/gh-pages/LICENSE)).
This version condenses the original, retains selected examples and rationale,
and separates local engineering guidance from Google-derived style rules.
Consult upstream for details and cases not summarized here.

Imperative rules are requirements; **prefer** and **avoid** indicate defaults
that admit justified exceptions; **may** indicates permission, not a requirement.
Examples illustrate particular decisions, not additional rules. Some snippets
omit surrounding declarations or deliberately show incorrect code.

## Scope and local exceptions

These are local policies, not a claim of exact Google-style conformance:

* Explicit repository instructions, established project conventions, and required
  framework or host contracts take precedence. Do not migrate existing code or
  change formatter, compiler, or lint policy just to apply this guide.
* Use the project's formatter for mechanical layout. Without a conflicting
  convention, follow Google's single quotes and explicit semicolons.
* Google-specific build tools, conformance frameworks, generated-proto rules,
  and optimization constraints are not requirements outside their environments.
* Google's named-export rule yields to existing project conventions and required
  default-export entry points. Google's prohibition on `#private` is a local
  preference for TypeScript visibility modifiers; use runtime privacy when the
  contract requires it and the target supports it. Parameter properties require
  an execution path that supports their transformation.
* Unlike Google's closed-codebase error assumption, external or host boundaries
  may throw non-Errors. Narrow caught values according to the actual API.
* Apply style without silently changing validation, retry policy, callback timing,
  side-effect order, or cleanup. Keep broad style migrations separate.

## Google-derived style rules

### Files, modules, and imports

* Use UTF-8. Apart from line terminators, use ASCII spaces for whitespace; escape
  other whitespace in literals. Prefer readable Unicode characters to cryptic
  escapes; explain escapes for non-printable characters.
* Order file sections: license/copyright if needed, `@fileoverview` if useful,
  imports, implementation. Separate present sections with one blank line.
* Use ES module imports and exports, not `namespace`, reference-path directives,
  or `require`-style imports. External interoperability may require an exception
  under the local policies above.
* Prefer relative imports within the same logical project. Avoid confusing chains
  of parent directories. Follow the project's module-resolution and extension
  rules rather than guessing at import paths.
* Prefer named imports for frequently used, clearly named symbols; use namespace
  imports when many symbols or ambiguous names benefit from a qualifier. Rename
  imports when needed for clarity or collisions, not gratuitously.
* Type-only dependencies may use `import type` or inline `type` imports; follow
  compiler requirements and project policy. Use `export type` for type re-exports.
  Use a separate side-effect import when an intentional runtime load is needed;
  type imports do not trigger it.
* Use named exports and export only what callers need. Do not export mutable
  bindings (`export let`); expose changing state through explicit operations.
* Use module scope for namespacing, not classes containing only static members.

**Named exports give an API a canonical name.** A required entry point is an
explicit local exception, not a reason to use defaults throughout the project.

```ts
// Avoid for an ordinary reusable module:
export default class RequestQueue {}

// Use instead:
export class RequestQueue {}
```

```ts
// Local exception: a host explicitly requires a default registration function.
export default function register(host: Host): void {
  host.addCommand('refresh', refresh);
}
```

### Naming

* Use descriptive ASCII identifiers. Short names are fine in small, obvious
  scopes, not exported APIs. Avoid obscure abbreviations and type-encoded names.
* Use `UpperCamelCase` for classes, interfaces, types, enums, type parameters,
  decorators, and TSX component functions. Type parameters may be a single
  uppercase letter or a descriptive name.
* Use `lowerCamelCase` for variables, parameters, functions, methods, properties,
  and namespace-import aliases. Treat acronyms as words: `loadHttpUrl`,
  `customerId`, not `loadHTTPURL` or `customerID`.
* Use `CONSTANT_CASE` for intended immutable module-level constants, static
  constants, and enum values, not every `const` local or instance field.
* Do not prefix interfaces with `I`, mark optional parameters with `opt_`, or
  prefix/suffix names with `_`, including unused parameters. Avoid `$` except
  established framework conventions; keep any Observable suffix consistent.
* Use `snake_case` filenames unless the project has an established convention.

### Variables, literals, and collections

* Use `const` by default, `let` for reassignment, never `var`. Declare one
  variable per declaration and do not use variables before declaration.
* Use array and object literals, not `Array()` or `Object()` constructors. Do not
  add non-index properties to arrays. Consider `Map` and `Set` for dynamic keys
  and membership rather than using objects as general-purpose dictionaries.
* Spread iterables into arrays and plain objects into objects. Do not spread
  arrays or primitives into objects; avoid spreading class instances. Spread is
  shallow and later properties overwrite earlier ones.
* Prefer named object fields over opaque positional tuples. Keep destructured
  parameters simple: one level of unquoted shorthand properties. Put defaults
  on individual bindings; default an optional destructured object to `{}` or
  array to `[]`, not to a populated replacement object or array.
* Prefer `for...of` for arrays and iterables; never use `for...in` for arrays.
  Prefer `Object.keys`, `Object.values`, or `Object.entries` for objects. If
  `for...in` is necessary, filter out inherited properties.
* Use single-quoted ordinary strings and template literals for interpolation or
  complex concatenation. Do not use backslash line continuations. Preserve
  intentional whitespace in multiline templates.
* Use lowercase `0x`, `0o`, and `0b` numeric prefixes, not legacy leading-zero
  octal syntax. Use standard character escapes rather than numeric equivalents.

**Binding defaults also apply to partially supplied options.** Defaulting the
whole object only covers an omitted argument, not its missing properties.

```ts
interface Options {
  attempts?: number;
}

// Avoid: configure({}) leaves attempts undefined.
function configure({attempts}: Options = {attempts: 3}) {}

// Use instead: both configure() and configure({}) receive the field default.
function configure({attempts = 3}: Options = {}) {}
```

This is guidance for designing an API, not permission to change an existing
API's defaulting behavior during a style-only cleanup.

### Functions and classes

* Prefer function declarations for named functions. Use arrows for callbacks
  and nested functions needing lexical `this`; do not use function expressions
  except for generators or APIs that genuinely require dynamic `this` binding.
* Use concise arrow bodies only when the return value is used; block bodies are
  also fine for clarity or multiple steps. For an unused return value, use a
  block body or explicit `void` to prevent an incidental value from leaking.
* Prefer explicit argument forwarding unless both callback signatures are known
  to be compatible. Do not pass unbound instance methods as callbacks.
* Prefer ordinary methods over arrow-function fields. Arrow fields are useful
  for handlers needing a stable, bound identity for removal. Do not install a
  listener with an inline `.bind()` and try to remove it with another `.bind()`.
* Parameter defaults must not have observable side effects. Prefer simple
  initializers and avoid exposing shared mutable state. Prefer an options object
  when more than a small handful of optional parameters have no natural order.
  Use rest parameters instead of `arguments`, and spread instead of `.apply()`.
* Use `this` only in appropriate class or explicitly typed function contexts and
  arrows capturing them, never to refer to the global object. Do not use static
  `this` or dynamic dispatch of static methods; call the defining class.
* Use constructor-call parentheses, including `new Foo()`. Omit redundant empty
  or forwarding constructors, but retain constructors with meaningful visibility,
  parameter properties, or decorators. Separate methods with one blank line.
* Initialize fields at declaration when possible. Use parameter properties over
  repetitive constructor assignment when supported. Mark properties `readonly`
  when only assigned during initialization; this is not deep freezing.
* Restrict visibility and exports. Omit redundant `public` modifiers except for
  non-readonly public parameter properties. Do not bypass privacy with bracket
  access; template- or framework-visible members need appropriate visibility.
* Getters must be side-effect-free. Avoid trivial getter/setter pairs that merely
  hide a field; use a public or readonly property instead. `toString()` must
  succeed without visible side effects.
* Do not manipulate prototypes, use mixins, or modify builtins. Framework-level
  prototype machinery is an exception, not a pattern for application code.

**Callback compatibility includes optional arguments.** `map` supplies an index,
which may accidentally become a formatting option even when types are accepted.

```ts
function formatCount(value: number, fractionDigits = 0): string {
  return value.toFixed(fractionDigits);
}

// Avoid: produces ['12', '34.0'] because the index becomes fractionDigits.
const labels = [12, 34].map(formatCount);

// Prefer: supplies only the argument intended by this call site.
const labels = [12, 34].map(value => formatCount(value));
```

**Concise bodies are an option, not a mandate.** A block is appropriate for a
multi-step calculation; callbacks intended only for effects must not leak a value.

```ts
const names = users.map(user => user.name);
const totals = orders.map(order => {
  const subtotal = sumItems(order.items);
  return subtotal + computeTax(subtotal);
});

// Avoid: this callback returns the array's new length.
const onMessage = (message: string) => messages.push(message);

// Prefer when the callback contract is effect-only:
const onMessage = (message: string) => {
  messages.push(message);
};
```

**Listener removal needs the same function identity.** In a browser target,
a bound arrow field can keep both `this` and the removable identity stable.

```ts
class ResizeTracker {
  count = 0;
  private readonly onResize = () => {
    this.count++;
  };

  start(): void {
    window.addEventListener('resize', this.onResize);
  }

  stop(): void {
    window.removeEventListener('resize', this.onResize);
  }
}
```

Calling `.bind(this)` separately in `start` and `stop` creates different
functions, so removal fails. Do not introduce arrow fields everywhere to solve
a problem specific to removable callbacks.

### Types and data models

* Infer obvious local types. Add annotations where they clarify complex values
  or meaningful API boundaries; return annotations are useful but not universally
  required by Google style. Follow project policy rather than adding redundancy.
* Use `interface` for object shapes, not classes or object-literal type aliases.
  Use type aliases for unions, tuples, primitives, and other type expressions.
* Check object literals against their intended structural type at declaration,
  rather than asserting `as SomeType`. Do not cast away missing or excess fields.
* Use `T[]` and `readonly T[]` for simple element types, including qualified
  names. Also use `T[][]` for non-readonly multidimensional arrays of simple
  types. Use `Array<T>` or `ReadonlyArray<T>` for complex elements such as unions
  or object types; apply the rule at each nesting level.
* Use the simplest type construct that expresses the model. Prefer explicit
  interfaces and composition to elaborate mapped or conditional types when
  these obscure relationships; modest repetition can be cheaper than cleverness.
* Prefer specific types or `unknown` to `any`. Document any unavoidable `any`
  narrowly. Use primitive `string`, `boolean`, and `number`, never wrapper types
  or their constructors. Avoid `Object` and `{}` as catch-all types; choose
  `unknown`, `object`, or `Record<string, T>` according to the actual contract.
* Consider `Map` for associative collections; give index-signature keys meaningful
  names when an object dictionary is appropriate. Use `Record` for known key
  sets when useful.
* Both `null` and `undefined` are valid absence values; follow the API contract.
  Add `| null` or `| undefined` at use sites rather than hiding absence in aliases.
  Prefer optional fields and parameters when omission is allowed. The local
  guidance below preserves cases where presence itself is part of the contract.
* Avoid return-type-only generics: they let callers claim an unchecked result.
  When an existing API has them, supply the type argument explicitly; it still
  does not validate the result.

**Interfaces describe object structure; aliases name other type expressions.**
This keeps the common object-shape convention consistent without banning unions.

```ts
// Avoid for an ordinary object shape:
type User = {id: string; name: string};

// Use instead:
interface User {
  id: string;
  name: string;
}

// Aliases are appropriate here:
type UserId = string;
type LoadResult = {kind: 'loaded'; user: User} | {kind: 'missing'};
```

**An annotation checks the object where it is built.** An assertion can hide an
incomplete implementation and move the eventual failure away from its source.

```ts
interface Job {
  id: string;
  attempts: number;
}

// Avoid: assertion conceals the missing attempts field.
const job = {id: 'j1'} as Job;

// Use instead: deleting attempts now produces a compiler error here.
const job: Job = {id: 'j1', attempts: 0};
```

**Array notation follows element complexity, not personal preference.**

```ts
// Use:
const names: string[] = [];
const users: readonly User[] = [];
const values: Array<string | number> = [];
const grid: string[][] = [];
const batches: ReadonlyArray<string[]> = [];

// Avoid:
const names: Array<string> = [];
const values: (string | number)[] = [];
const grid: Array<string[]> = [];
```

### Narrowing, coercion, and control flow

* Prefer runtime narrowing to `as` or `!`. If an assertion is genuinely justified,
  keep it narrow and explain the invariant unless obvious. Use `as`, not angle-
  bracket assertions; if a double assertion is unavoidable, go through `unknown`.
* Use `===` and `!==`. Comparing to literal `null` with `==` or `!=` is allowed
  when intentionally checking both `null` and `undefined`.
* Use `String()`, `Boolean()`, templates, or `!!` for explicit conversions, not
  empty-string concatenation. Avoid redundant boolean coercion in conditions.
  Compare enums explicitly; do not rely on their truthiness, since zero is valid.
* Use `Number()` for decimal parsing and check for `NaN`, unless failure is
  impossible from context. Do not use unary `+`, `parseFloat`, or decimal
  `parseInt`. For non-decimal `parseInt`, validate digits and specify the radix.
* Use braces for control-flow blocks and put non-empty bodies on their own line.
  Google permits a one-line `if` without braces; follow local convention.
  Avoid assignments in conditions; parenthesize an intentional assignment.
* Include a final `default` in switches. Non-empty cases must terminate with
  `break`, `return`, or `throw`; only empty cases may fall through.
* Use parentheses where precedence could confuse a reader, not around every
  expression regardless of clarity.

**Numeric conversion is not necessarily domain validation.** Partial parsing can
hide invalid suffixes; `Number()` avoids that but still accepts empty input and
infinity. Additional checks depend on the API's acceptance rules.

```ts
// Avoid: silently accepts a trailing unit as the number 12.
const count = parseInt('12items', 10);

// Example contract: Number-compatible syntax, with a non-negative integer result.
function parseCount(text: string): number {
  const count = Number(text);
  if (text.trim() === '' || !Number.isInteger(count) || count < 0) {
    throw new Error('Expected a non-negative integer');
  }
  return count;
}
```

This contract accepts `1e2` and non-decimal prefixes such as `0x10`. A decimal-
only or digits-only grammar needs its own check; `Number()` does not establish
either. Do not tighten or widen an existing parser's grammar as a style fix.

### Errors and restricted features

* Throw `new Error(...)` or an appropriate subclass for exceptional failure; do
  not throw or reject with strings or arbitrary values. Prefer exceptions over
  ad-hoc error containers. Existing expected-outcome APIs remain valid under
  the local contract-preservation policy.
* Keep `try` blocks focused. Explain intentionally ignored exceptions. Google's
  error-handling model assumes thrown values are `Error` instances; see the
  explicit local exception for external boundaries below.
* Do not use `const enum`, production `debugger`, `with`, `eval`, or string-based
  `Function` construction. Specialized code loaders are the upstream exception
  for dynamic evaluation, not a general application technique.
* Do not define custom decorators; use supported framework-provided decorators
  only. Put JSDoc before decorators and decorators immediately before the symbol.
* Do not use non-standard or proposal-stage language features or add unnecessary
  globals. Runtime-specific APIs are fine when the target supports them.
* Do not suppress checking with `@ts-ignore` or `@ts-nocheck`. Google's limited
  `@ts-expect-error` exception is for unit tests; prefer narrowly explained test
  expressions, and do not blanket-suppress compiler errors.

### Comments and maintenance

* Use `/** JSDoc */` for API documentation and `//` for implementation comments,
  including multiline implementation explanations. Document top-level exports
  except tooling-only exports, and members whose purpose is not obvious.
* Add information rather than repeating names or TypeScript types. Omit redundant
  JSDoc type annotations and tags already expressed by language keywords.
* Write JSDoc in Markdown, put block tags on separate lines, and indent wrapped
  tag descriptions four spaces. Add `@param` and return descriptions only when
  informative; document parameter properties through constructor `@param` tags.
* For otherwise unclear positional arguments, prefer a clearer API or use
  `/* parameterName= */ value` comments. Mark deprecations with `@deprecated` and
  actionable migration advice.
* Keep changes scoped; avoid opportunistic reformatting that obscures the task.
  Generated code is generally exempt, though identifiers consumed by handwritten
  code should follow naming rules where the generator permits it.

**Document constraints that types cannot express, not the spelling of the type.**

```ts
// Avoid: adds nothing to the signature.
/** @param delayMs The delay as a number. */

// Prefer, on the actual declaration:
/**
 * Schedules one retry unless the request has been cancelled.
 * @param delayMs Non-negative delay; the caller retains cancellation ownership.
 */
export function scheduleRetry(delayMs: number): void {
  // Implementation omitted.
}
```

## Local engineering guidance

The following supplements Google style. It is local policy for safe application
work, not attributed to Google or a reason to redesign a small change.

### Data boundaries and absence

* Treat parsed JSON and external data as `unknown` until validated. Assertions,
  `satisfies`, and generic parse signatures do not perform runtime validation.
  A predicate must establish every property it promises, including nested fields.
* Prefer discriminated unions for genuinely distinct states or outcomes, readonly
  inputs when mutation is not part of the contract, and names over opaque boolean
  parameters or unexplained tuples. Do not invent frameworks for small protocols.
* Preserve distinctions between omitted fields, `undefined`, and `null` when the
  runtime, serialization, or compiler contract depends on them.

**Validation establishes the promised shape, not just an envelope.**

```ts
interface Message {
  payload: {text: string};
}

// Avoid: neither a cast nor checking only payload proves payload.text is valid.
const message = JSON.parse(input) as Message;

// Prefer at an untrusted boundary:
function parseMessage(input: string): Message {
  const value: unknown = JSON.parse(input);
  if (typeof value !== 'object' || value === null ||
      !('payload' in value)) {
    throw new Error('Expected a message object');
  }
  const payload = value.payload;
  if (typeof payload !== 'object' || payload === null ||
      !('text' in payload) || typeof payload.text !== 'string') {
    throw new Error('Expected a text payload');
  }
  return {payload: {text: payload.text}};
}
```

This example requires a compiler that supports narrowing unknown properties with
`in`. It returns normalized data and does not preserve extra fields; use that
behavior only when the boundary contract permits it.

**Optional and required-but-undefined are different contracts.** With
`exactOptionalPropertyTypes` enabled, these assignments illustrate the difference:

```ts
interface Patch {
  title?: string; // Omission means leave unchanged; a string means replace.
}

interface Snapshot {
  title: string | undefined; // The property must be present.
}

const patch: Patch = {}; // Valid.
const patch: Patch = {title: undefined}; // Invalid with that compiler option.
const snapshot: Snapshot = {title: undefined}; // Valid.
const snapshot: Snapshot = {}; // Invalid: required property missing.
```

Choose the type that expresses the API. Do not mechanically replace every
`| undefined` with `?`, or add `null` without a defined meaning.

### Failure handling, asynchronous work, and ownership

* Catch to recover, translate, isolate, or report, not to disguise failure as
  success. Preserve the original error when unhandled. Use ordinary result
  values for expected outcomes only when the API defines them.
* Narrow unknown catch values before accessing fields. At known internal
  boundaries, do not repeatedly normalize impossible error shapes; at external
  boundaries, account for the actual thrown values.
* Await promises or deliberately hand them off with explicit rejection handling.
  `void` alone does not handle a rejected promise. Use `finally` for mandatory
  cleanup and make shutdown idempotent where multiple paths can close resources.
* Make ownership of timers, listeners, sockets, subscriptions, and pending work
  visible, including how completion, cancellation, timeout, and shutdown settle
  work and release resources. Preserve session/generation checks across awaits.
* Keep I/O and host interactions at visible boundaries. Distinguish request
  acceptance from completion; correlate responses by identity, not arrival order.
  Retry only when safe and bounded; ambiguous delivery is not permission to replay.

**Throw Errors yourself, but do not blindly trust external thrown values.**
This external-boundary example reports a failure without assuming `.message`:

```ts
try {
  await externalHost.save();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  showSaveFailure(message);
  throw error; // Preserve the original when this boundary cannot recover.
}
```

**Discarding a promise value does not handle its rejection.**

```ts
// Avoid: rejection remains unhandled.
void refresh();

// Prefer when this task owns completion:
await refresh();

// Or: a deliberate background handoff to a non-throwing failure reporter.
void refresh().catch(reportRefreshFailure);
```

The reporter must not throw or return an unhandled rejected promise. Do not add
background execution where callers previously waited for completion.

### Readability, compatibility, and verification

* Prefer early returns, ordinary branching, and named intermediate values to
  dense ternaries or clever chains. Extract helpers that name real operations,
  invariants, or boundaries, not arbitrary fragments of a coherent decision.
* Verify unfamiliar or version-sensitive APIs against installed declarations,
  source, or target documentation. Type declarations, transpilation, and type
  stripping do not establish runtime availability or supply missing APIs.
* Use the existing compiler, formatter, linter, build, and test commands. Do not
  add Google tooling, compatibility shims, or dependencies merely for this guide.
* Review observable behavior as well as style: acceptance rules, side-effect
  order, callback timing, stale-result handling, and cleanup. Report exactly what
  was checked and what could not be verified; types are not runtime proof.
