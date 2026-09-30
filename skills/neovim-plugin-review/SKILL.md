---
name: neovim-plugin-review
description: Review a Neovim plugin for modern loading, configuration, keymap, lifecycle, state ownership, performance, interoperability, API, testing, and documentation practices. Use when auditing a Neovim plugin, reviewing plugin architecture or a pull request, or checking whether a plugin behaves like a well-mannered modern Neovim plugin.
---

# Neovim Plugin Review

Review the plugin as a Neovim user and maintainer. Find observable defects and architectural risks, not merely stylistic differences.

Read [references/guidelines.md](references/guidelines.md) completely before reviewing.

## Review mode

Default to review-only mode:

- Do not edit code unless the user asks for fixes.
- Run existing checks when useful and safe, but do not generate or rewrite files.
- Respect repository instructions and supported Neovim versions.
- Judge intentional trade-offs in their documented context; do not enforce the guide mechanically.
- Distinguish official Neovim requirements, established conventions, and debated ecosystem preferences. A preference is not a defect without concrete impact.

If the scope is ambiguous, review the current working tree. If the user names a commit, diff, pull request, module, or feature, limit findings to that scope while reading enough surrounding code to verify behavior.

## Workflow

### 1. Establish context

Read repository instructions, the README, help files, configuration documentation, and test commands. Identify:

- supported Neovim and Lua runtime versions;
- documented setup and lazy-loading behavior;
- public commands, mappings, and Lua APIs;
- optional and required dependencies;
- release, compatibility, and deprecation policy;
- repository-specific lifecycle and state invariants.

### 2. Map activation paths

Inspect conventional runtime entry points and their reachable modules:

- `plugin/`, `after/`, `ftplugin/`, `ftdetect/`, `autoload/`, and `queries/`;
- the root Lua module and `setup()`;
- user commands and `<Plug>` mappings;
- autocommands, filetype hooks, and dependency integrations.

Trace what happens at module load, setup, first invocation, repeated setup, and teardown. Distinguish cheap module definition from expensive or user-visible work.

### 3. Trace state and resource ownership

Locate mutable state and determine whether each value is global, project-local, buffer-local, window-local, persistent, or volatile. Trace creation, invalidation, and cleanup for:

- buffers, windows, namespaces, extmarks, and highlights;
- augroups and autocommands;
- timers, jobs, scheduled callbacks, and subscriptions;
- filesystem, Git, Treesitter, and cached data.

Pay special attention to stale asynchronous results and persistent data represented by volatile Neovim handles or coordinates.

### 4. Review user-facing contracts

Check configuration validation and merge semantics, mapping conflict and disable behavior, command namespace/completion/errors, public API stability, context preservation, optional dependency handling, Lua and Neovim compatibility, and plugin-manager independence.

### 5. Review performance and verification

Look for expensive work on startup or frequent events, unbounded retained state, duplicate resources after setup, and repeated filesystem, Git, or parser work. Inspect tests for observable lifecycle outcomes. Run the narrowest relevant existing checks when they can confirm or reject a suspected finding.

### 6. Report findings

Report only actionable findings supported by code or reproducible behavior. For each finding include:

1. severity and concise title;
2. file and line reference;
3. triggering scenario;
4. observable impact;
5. the smallest appropriate remediation direction.

Order findings by severity. Use these levels:

- **Critical** — data loss, destructive behavior, or broadly unusable plugin.
- **High** — common workflow breaks, persistent state corruption, serious resource leak, or major compatibility failure.
- **Medium** — real defect under a plausible lifecycle, configuration, or interoperability scenario.
- **Low** — limited robustness, performance, discoverability, or maintainability problem with concrete impact.

Do not inflate preference differences into findings. Examples are not findings unless they cause concrete harm: mandatory `setup()` by itself, a small set of guarded and disableable default mappings, lack of `<Plug>` mappings when a Lua API exists, use of globals with deliberate ownership, a chosen test framework, or eagerly loading a tiny side-effect-free Lua module.

Separate unverified concerns under **Questions or residual risks**. If there are no findings, say so explicitly and note the most important areas inspected and any test limitations.

## Output shape

```markdown
## Findings

### [High] Stale job result updates a reused buffer
`lua/plugin/index.lua:84`

If the buffer is deleted and its number is reused before the job completes, the callback applies results to an unrelated buffer. This can display or persist incorrect navigation state. Associate the request with a generation or stable identity and reject obsolete results.

## Questions or residual risks

- Treesitter behavior could not be exercised because the documented parser was unavailable.

## Verification

- `just test --filter lifecycle` — passed
```

Keep the summary brief. Findings are the primary output.