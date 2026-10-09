---
name: lua-styleguide
description: Use when writing, reviewing, debugging, or migrating Lua code. Follow Lua style and module-layout guidance, and verify compatibility with the project's Lua runtime and host APIs.
---

# Lua Development

Prefer straightforward Lua with explicit dependencies, state ownership, and
failure policy. Do not assume standalone Lua, LuaJIT, and embedded Lua hosts
provide the same language features or libraries.

## Writing and reviewing code

Read `references/style-guide.md` completely before writing or reviewing Lua code.
Existing project conventions take precedence over this guide. Formatting belongs
to the project's StyLua configuration, not this skill. Use the application-design
and testing-styleguide skills for their broader principles where relevant.

Identify the supported Lua versions, runtime or host, module layout, and tooling
from repository instructions, configuration, and existing code. If the target is
unclear, ask before introducing version-specific syntax or APIs.

For Neovim plugin audits, also use the neovim-plugin-review skill. Keep general
Lua style distinct from Neovim loading, configuration, and lifecycle policy.

## Checking runtime and library APIs

Before introducing an unfamiliar or version-sensitive API, verify it against the
project's target runtime documentation, installed library source, or host help.
For Lua's standard library, use the reference manual for the supported version;
for LuaJIT extensions, use LuaJIT documentation; for host APIs, use that host's
versioned documentation. Report unavailable verification rather than guessing.

Do not infer LuaJIT compatibility from the Lua version number alone, or assume a
host's globals are available in ordinary Lua. Avoid compatibility shims unless
support for multiple runtimes is an actual project requirement.

## Validating changes

Run the project's documented formatting, linting, and test commands relevant to
the change. Respect existing StyLua, Luacheck, Lua language-server, and test-runner
configuration rather than adding tools or changing policy unprompted.

Validate with the supported runtime or host. A syntax check under standalone Lua
does not establish compatibility with LuaJIT or an embedded host, and language-
server annotations do not replace runtime validation. State any checks that
could not be run.
