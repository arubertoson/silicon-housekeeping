# Keymaps extension

`keymaps.ts` binds multi-key sequences to Pi slash commands.

## Config files

The extension reads both files on every `session_start`, in this order:

1. `~/.pi/agent/keymaps.json`
2. `<cwd>/.pi/keymaps.json`

Project keymaps are session/cwd-specific. When Pi switches sessions, resumes a session from another cwd, forks, or creates a new session, the extension reloads keymaps for the new session cwd.

## Format

Each file must contain an array of entries:

```json
[
  {
    "sequence": ["ctrl+x", "n"],
    "description": "new session",
    "command": "new"
  },
  {
    "sequence": ["ctrl+x", "m"],
    "description": "switch model",
    "command": "model"
  },
  {
    "sequence": ["ctrl+x", "s"],
    "description": "rename session",
    "command": "name",
    "args": "work session"
  }
]
```

Fields:

- `sequence`: required non-empty array of key ids.
- `description`: optional string for humans.
- `command`: required Pi slash command name without `/`.
- `args`: optional raw argument string passed to the command.

## Key ids

Supported keys are:

- single lowercase letters: `a` through `z`
- digits: `0` through `9`
- Pi TUI named keys such as `escape`, `enter`, `tab`, `pageUp`
- modified keys with `ctrl+`, `alt+`, `shift+`, or `super+`

Examples:

```json
"a"
"escape"
"ctrl+x"
"ctrl+shift+p"
"alt+enter"
```

## Sequence behavior

A sequence can share prefixes with other sequences:

```json
[
  { "sequence": ["ctrl+x", "n"], "command": "new" },
  { "sequence": ["ctrl+x", "m"], "command": "model" }
]
```

After `ctrl+x`, the editor waits for the next key. Pressing `escape` cancels the active sequence. If the user pauses part-way through a sequence, it resets after 1500 ms.

Unmatched keys are passed through to Pi's normal editor.

## Errors

Invalid files, invalid entries, duplicate sequences, and command execution failures are shown as Pi notifications. A missing config file is ignored.
