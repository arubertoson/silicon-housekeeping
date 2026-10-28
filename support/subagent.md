# Subagent runner

`extensions/subagent.ts` is a single-file Pi 1.4.0 extension, discovered on
`/reload` when this repository is linked to `~/.pi/agent`. It retains pi-amplike's collapsed progress
boxes, expanded Markdown output, tool-call previews, usage, and model badges.

The rendering was deliberately adopted from
[pasky/pi-amplike](https://github.com/pasky/pi-amplike), commit
`4019ce681df16c65e6dadb82427a0cf16c57a147`. Its required MIT notice remains in
the source header.

## Invocation

```json
{
  "tasks": ["Review ./draft.md and return a short list of corrections."],
  "tools": ["read"],
  "skills": ["writing"]
}
```

- `tasks`: independent prompts, run up to four at once. Include all necessary
  context: every child starts a fresh conversation without parent messages.
- `model`: optional exact `provider/modelId`. Otherwise inherit the parent's
  model. Thinking inherits from the parent, subject to Pi's model capability
  clamping. Unknown explicit models fail rather than falling back.
- `tools`: omitted preserves Pi defaults; `[]` disables all agent-callable
  tools. A nonempty list enables only exact available names, including
  non-default built-ins such as `grep`. Unknown names, patterns, and `+name` or
  `-name` modifiers fail before prompting.
- `skills`: omitted preserves Pi discovery; `[]` exposes none. Nonempty lists
  select discovered names or explicit skill files/root directories. Relative
  paths use the child cwd; prefix directory paths with `./` to distinguish them
  from names. Missing or ambiguous selections fail before prompting. Pi handles
  discovery and parsing; selection advertises skills without injecting bodies.

Both lists apply to every task. Each child owns its settings, resource loader,
conversation, and tool configuration; parent and sibling selections are unchanged.

## Native Pi behaviour

The runner uses normal SDK tools, including ordinary bash. It has no Amp
permissions, `amplike.json`, mode presets, custom settlement polling, or
compaction-resume prompts. Pi owns retries, compaction, and idle detection.
Cancellation awaits native abort; cleanup emits extension shutdown and disposes
the session. Transcripts persist in Pi's normal session storage and are linked
to the parent session when available. Results include session paths.

Extensions are not automatically rediscovered in in-process children, to avoid
reusing parent extensions with shared module state. Programmatic callers of
`runSubagent()` can supply `extensionPaths` explicitly; these paths use Pi's
resource loader and child cwd. Only use extensions safe for concurrent sessions.
There is no separate extension configuration file or invocation parameter.

This is context/tool configuration, **not an OS sandbox**. Children share the
filesystem and process authority. The SDK creates each child's normal model/auth
runtime; parent-only runtime provider registrations are not copied.

## Verification

```sh
npm test -- tests/subagent.test.ts
```

Tests use real SDK resource discovery and session construction, plus synthetic
provider streams for native retry, cancellation, persistence, and cleanup checks.
They are offline and credential-free. Live providers, terminal interaction, and
end-to-end compaction have not been exercised.
