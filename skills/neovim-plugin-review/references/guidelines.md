# Modern Neovim Plugin Review Guidelines

Use this guide as a diagnostic framework, not a rigid style standard. Repository requirements, supported Neovim versions, and documented design decisions take precedence.

Calibrate findings by authority:

1. Neovim API/runtime documentation and observable correctness;
2. established Vim/Neovim conventions;
3. prominent ecosystem guidance;
4. maintainer preference.

Only the first three normally justify findings, and conventions still require concrete impact. The ecosystem disagrees about mandatory `setup()`, `vim.g` versus Lua configuration, plugin-managed versus manager-managed lazy loading, default mappings, and test frameworks. Review outcomes, not allegiance to one camp.

## 1. Loading and activation

### Expected properties

- Public library-style modules, especially the root Lua module, avoid surprising user-visible work on `require()`.
- Filesystem access, Git operations, parsing, jobs, timers, and UI creation wait until the feature needs them.
- Runtime entry points are lightweight and use standard Neovim mechanisms; `plugin/` scripts may intentionally register cheap commands, `<Plug>` mappings, and autocommands.
- Core behavior does not depend on a specific plugin manager.
- Optimization targets meaningful work; eagerly loading a small side-effect-free module is not inherently a problem.

```lua
local M = {}

function M.open()
  return require("plugin.ui").open()
end

return M
```

Investigate module-scope calls that mutate options, create UI, scan projects, start jobs, or register unrelated behavior. Do not report registration in a conventional runtime entry point merely because it is a side effect.

A global `plugin/<name>.lua` entry point should normally support Neovim's conventional disable/reload guard when appropriate:

```lua
if vim.g.loaded_plugin_name then
  return
end
vim.g.loaded_plugin_name = true
```

This is most important for automatically sourced entry points. It lets users disable the plugin before startup and avoids duplicate registration when sourced twice.

## 2. Setup and configuration

### Expected properties

- Configuration and initialization have distinguishable responsibilities.
- Sensible defaults work without `setup()` when practical.
- Mandatory setup is clearly documented and fails clearly when omitted.
- `setup()` validates input and enables configured behavior rather than merely copying defaults.
- Repeated setup is idempotent, performs teardown first, or is explicitly rejected.
- User input, normalized configuration, and runtime state remain distinct.
- List, callback, mapping, and nested-table merge semantics are intentional and documented.
- Unknown or invalid options produce actionable errors instead of being silently ignored.

```lua
local defaults = { mappings = false }

function M.setup(opts)
  opts = opts or {}
  validate(opts)
  config = normalize(vim.tbl_deep_extend("force", defaults, opts))
end
```

Do not report mandatory setup as a defect unless it produces an actual usability, loading, ordering, or correctness problem. Opinionated guides reject mandatory setup, while widespread plugins and plugin managers explicitly support it; the balanced question is whether the chosen design has justified initialization semantics and predictable ordering.

## 3. Commands and mappings

### Expected properties

- Core actions are callable independently of concrete default key choices.
- Plugins avoid excessive or surprising global mappings.
- Defaults, if provided, are conventional, guarded against conflicts, and easy to disable or replace.
- Existing user mappings are not silently overwritten; consider `<Plug>`, `hasmapto()`, buffer-local mappings, and documented disable switches.
- Plugin-created mappings and autocommands have useful `desc` values.
- Commands have descriptions, validate arguments, and provide completion where useful.
- Related actions use subcommands when many top-level commands would pollute completion.
- `<Plug>` mappings may provide stable mapping targets, but a documented Lua API or command can serve the same composability goal.

```lua
vim.keymap.set("n", "<Plug>(PluginOpen)", function()
  require("plugin").open()
end, { desc = "Open plugin" })
```

## 4. Scope and state ownership

Classify state before judging it:

- editor-global;
- project or repository-local;
- tab-local;
- window-local;
- buffer-local;
- persistent semantic identity;
- volatile Neovim resource.

### Expected properties

- Buffer-specific behavior is buffer-local where practical.
- Persistent identities are not represented solely by buffer numbers, window IDs, extmarks, or line numbers.
- Paths and semantic locations remain separate from volatile editor handles.
- Caches have an owner, invalidation rules, and bounded lifetime.
- State from one project, tab, window, or buffer cannot leak into another.

## 5. Resource lifecycle

Every created resource needs an owner and an end-of-life condition:

- augroups and autocommands;
- namespaces, extmarks, diagnostics, and highlights;
- timers, jobs, callbacks, and subscriptions;
- scratch buffers and windows;
- temporary files and cached entries.

Repeated setup or feature activation must not duplicate resources accidentally.

```lua
local group = vim.api.nvim_create_augroup("PluginName", { clear = true })

vim.api.nvim_create_autocmd("BufDelete", {
  group = group,
  callback = function(args)
    require("plugin.state").remove_buffer(args.buf)
  end,
})
```

Check cleanup on buffer deletion, window closure, tab closure, project switches, feature disablement, and plugin reconfiguration—not only on editor exit.

## 6. Boundary validation and invariants

Validate external or volatile inputs at boundaries:

- user configuration;
- filesystem paths and contents;
- Git output and repository state;
- Treesitter parser availability and returned nodes;
- buffer and window handles;
- asynchronous results.

After validation, established internal contracts may be trusted. Broad defensive checks can conceal invariant violations and make corruption harder to diagnose.

```lua
-- Appropriate when deletion during asynchronous work is expected.
if not vim.api.nvim_buf_is_valid(buf) then
  return
end
```

Distinguish an expected race such as a closed preview window from an impossible internal state such as a supposedly indexed item with no identity.

## 7. Asynchronous correctness

Assume buffers, windows, files, projects, and requests can change while work is pending.

Verify that callbacks establish all relevant facts before applying a result:

- the target resource still exists;
- its identity has not been reused;
- the request is still the newest relevant request;
- source text or repository state has not invalidated the result;
- scheduled work belongs to the same project and feature generation.

Handle cancellation where available. Otherwise attach stable identity or generation tokens and discard obsolete results.

A validity check alone may be insufficient because Neovim can reuse handles.

## 8. Performance

Review observable costs rather than startup time alone:

- startup and setup duration;
- first-use latency;
- work on frequent events;
- redraw frequency;
- repeated filesystem, Git, or Treesitter operations;
- memory retained after resources close;
- unnecessary scheduling and callback accumulation.

Handlers for `CursorMoved`, `TextChanged`, `BufEnter`, and similar events should be cheap. Prefer invalidation, incremental updates, bounded caches, and deliberate debouncing when correctness permits.

Avoid both speculative work and repeated recomputation of expensive stable data.

## 9. User context and interoperability

### Expected properties

- Actions do not unexpectedly change the current buffer, window, cursor, mode, working directory, options, registers, marks, jumplist, or search pattern.
- Temporary context changes are restored even when an operation fails.
- Standard public Neovim APIs are preferred over undocumented internals.
- Feature detection is preferred when version checks do not accurately describe capability.
- Code targets the Lua API promised by Neovim: Lua 5.1 unless a LuaJIT requirement is explicit; LuaJIT-only facilities are gated with `jit`.
- APIs unavailable on the oldest supported Neovim version are gated or the version requirement is accurate.
- Optional dependency failure disables only the affected integration.
- Native packages, direct `require()`, and common plugin managers remain viable where practical.

Inspect command execution and window switching carefully: restoring only the cursor is insufficient if the current window or buffer also changed.

## 10. Core behavior and UI

### Expected properties

- Navigation, storage, parsing, and state transitions do not inherently depend on a picker or floating-window implementation.
- UI adapters call reusable core operations.
- UI creation does not unexpectedly steal focus or permanently alter layout.
- Scratch buffers and floating windows have clear ownership and cleanup.
- Standard highlights and interaction conventions are used where appropriate.

```lua
local point = require("plugin.points").find(id)
return require("plugin.navigation").visit(point)
```

## 11. Public API and errors

### Expected properties

- Public modules and internal modules are distinguishable.
- Public functions and configuration use LuaCATS annotations where they materially improve editor support and static checking.
- Commands, configuration, documentation, and APIs use consistent domain terminology.
- Public actions return useful structured results when composition requires them.
- Expected environmental failures produce concise, actionable messages.
- Internal invariant failures remain visible.
- Deprecations provide warnings and a migration path.

An actionable error states what failed, gives relevant context such as a path or option, and tells the user how to recover.

## 12. Documentation and health checks

Look for:

- minimal installation and usage instructions;
- whether setup is optional or required;
- documented commands, mappings, and public APIs;
- full configuration semantics without requiring users to copy all defaults;
- optional dependencies and supported Neovim versions;
- migration notes and deprecation paths for breaking changes;
- a stated release/versioning policy when users consume tagged releases;
- `:help` documentation and generated tags;
- `:checkhealth` when behavior depends on executables, parsers, providers, or environment configuration.

Documentation disagreement with behavior is a finding when it can mislead users.

## 13. Tests

Prefer tests of observable behavior through real Neovim APIs, files, parsers, and Git metadata. Important scenarios include:

- loading with default or absent configuration;
- repeated setup and teardown;
- buffer, window, and tab deletion;
- project and file changes;
- async completion after deletion or supersession;
- absent optional dependencies;
- unavailable Treesitter parsers;
- persistent state after buffer recreation;
- command, UI, and navigation outcomes;
- the oldest supported Neovim version.

Missing tests alone are usually a residual risk, not a code defect. Report a finding when an untested path has a concrete bug or when the project explicitly requires that coverage. Do not prescribe Plenary, busted, `nvim -l`, or another framework unless the repository has made that choice; the community has preferences, not one correctness requirement.

## Compact review checklist

- [ ] Module loading has no surprising side effects.
- [ ] Native runtime entry points are lightweight and disableable where appropriate.
- [ ] Expensive work happens only when justified.
- [ ] Configuration and initialization responsibilities are clear.
- [ ] Setup semantics are documented and safe on repetition.
- [ ] User keyspace remains under user control.
- [ ] Configuration is validated at its boundary.
- [ ] Persistent identities and volatile handles remain separate.
- [ ] State and resources have explicit owners and cleanup.
- [ ] Async results cannot update stale or reused state.
- [ ] Frequent events avoid unconditional expensive work.
- [ ] User context is preserved.
- [ ] Optional integrations fail locally.
- [ ] Lua and Neovim compatibility match documented requirements.
- [ ] Core behavior is independent of UI and plugin managers.
- [ ] Public contracts are typed where useful, stable, documented, and actionable on failure.
- [ ] Tests cover observable navigation and lifecycle outcomes.

## Sources and ecosystem position

This guide was validated against:

- [Neovim Lua guide](https://neovim.io/doc/user/lua-guide.html), including deferred `require()`, mapping descriptions, buffer-local mappings, and augroups.
- [Neovim plugin authoring conventions](https://neovim.io/doc/user/usr_41.html#write-plugin), including `g:loaded_*`, `<Plug>`, `hasmapto()`, `<Leader>`, `<LocalLeader>`, and mapping disable switches.
- [Neovim Lua compatibility](https://neovim.io/doc/user/lua.html#lua-compat), which defines Lua 5.1 as the supported plugin interface and requires gating LuaJIT extensions.
- [Neovim health-check documentation](https://neovim.io/doc/user/health.html#health-dev).
- [lazy.nvim documentation](https://lazy.folke.io/spec/lazy_loading), representing prevalent plugin-manager behavior around module, command, event, filetype, and key-triggered loading.
- [nvim-neorocks modern plugin best practices](https://github.com/nvim-neorocks/nvim-best-practices), an opinionated community guide covering initialization, mappings, validation, health checks, typing, releases, and testing.
- [Structuring Neovim Lua plugins](https://zignar.net/2022/11/06/structuring-neovim-lua-plugins/) by Matthias Fussenegger, a deliberately balanced treatment of runtime entry points, setup trade-offs, `require()` cost, and internal lazy loading.
- [Rethinking the setup convention](https://mrcjkb.dev/posts/2023-08-22-setup.html), representing the stronger configuration/initialization-separation position and documenting that the topic remains debated.

The stable common ground is: keep startup registration cheap, defer substantial work, preserve user control, use native runtime mechanisms, and make lifecycle ownership explicit. Treat the exact configuration API and lazy-loading mechanism as design choices whose consequences must be reviewed, not as universal pass/fail rules.
