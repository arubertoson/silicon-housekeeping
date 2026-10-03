# 🧹 silicon housekeeping -- aru's agent cupboard

> **Disclaimer:** This is my personal agent configuration. It's built around
> how I work, on the machines I use, with the agents I tolerate. It will most
> likely not work out of the box for you, and that's fine. It's mine, and I
> like it.

Extensions, skills, prompt commands, and the supporting code that keeps the
silicon inhabitants from leaving their shoes in the hallway.

The layout is inspired by [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff).
Things I author or deliberately maintain live here. Third-party material stays
in `~/.config/agents/`. Borrowing a broom doesn't make it mine; see
[`AGENTS.md`](AGENTS.md) for the ownership boundary.

## Layout

- `extensions/` — extension source, grouped by extension where appropriate.
- `skills/` — internal skills and their references.
- `commands/` — Pi prompt commands/templates.
- `support/` — shared implementation code used by extensions.
- `tests/` — tests, kept out of the extension-loading path.
- Root-level `settings.json` and `keybindings.json` — Pi runtime configuration. This repository can be linked directly to `~/.pi/agent`; do not commit credentials, sessions, trust state, logs, package caches, or installed dependencies.
- `projects/pi-mono/.pi/` — Pi-mono-specific project resources, kept separate from global user configuration.

## Workflow

`/commit [issue] [files/instructions]` is an extension, not a prompt template.
Code selects and validates Git or jj (jj wins when colocated); the agent reviews
and commits the requested work locally. It uses `gpt-6-luna` with low thinking,
then restores the previous model and thinking level unless you changed them.
No push. No PR. No task-tracker ceremony required. Run `/reload` after changing
extensions in a live session.

For local Pi development, `just link-agent` links this repository directly to
`$HOME/.pi/agent`. This is the actual cupboard, not a showroom copy.

**Do not run this until the staged configuration has been reviewed and the
live-session switch is intentional.** Set `PI_AGENT_DIR` to override the
destination.

## Editor snippets

`extensions/snippets.ts` expands `;name` references in the editor using Pi's
autocomplete hook. It preserves the existing editor component, including
`prompt-editor`, and only takes over navigation while a snippet session is active.

Edit `~/.pi/agent/snippets.json` (included here as an empty object):

```json
{
  "careful": "Check edge cases and avoid unrelated changes.",
  "tests": "Add regression tests for the behavior being changed.",
  "steps": "First, explain the plan.\nThen implement it.",
  "function": "function ${1:name}(${2}) {\n  ${3}\n}"
}
```

Run `/reload` after editing. The path follows `PI_CODING_AGENT_DIR` when set.
Names are case-sensitive and use letters, digits, underscores, or hyphens;
omit the leading `;` in JSON keys. Definitions are global, not project-local.
Missing configuration means no snippets; invalid JSON or definitions produce
a warning and disable snippets until corrected and reloaded.

Type `;` at the start of a line or after whitespace to see snippets, or type
`;prefix` to filter names. Use arrow keys to choose, then **Tab** to insert.
An exact name expands on Tab even without an open completion menu. Unknown
names remain unchanged. Native autocomplete also accepts **Enter** when its
menu is open; this inserts the snippet without submitting the message.

Only the reference before the cursor is replaced and surrounding text is
preserved. With no fields, the cursor lands after the expansion; normal editor
undo restores the reference. Multiline strings use JSON `\n` escapes.

Use `${1:default}` for a field with default text and `${2}` for an empty field.
Field numbers must be unique positive safe integers and determine navigation
order; defaults are replaced when you start typing. While a snippet is active, **Tab** advances,
**Shift+Tab** goes back, and **Escape** or Tab at the last field finishes at the
end of the expansion. Other autocomplete behavior resumes after finishing.
Edits are tracked only within the active field. Undo, submission, edits outside
that field or across markers, and external text replacement end navigation
without reverting the user's edits. Text outside fields is literal; fields are
single-use, with no linked values, recursive expansion, or transformations.

## Development

Run `npm test` for the test suite. The commit extension tests use temporary real
repositories and require Git and jj on `PATH`; no model credentials are needed.
