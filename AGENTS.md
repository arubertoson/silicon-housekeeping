# Silicon Housekeeping

This repository is the canonical home for configuration and tools I author or actively maintain for my agent workflows.

## Ownership boundary

- Internal means authored or deliberately maintained here. Keep those assets in the top-level source directories.
- External means third-party material I use but do not maintain. Keep it in `~/.config/agents/` (currently exposed as `~/.agents/`); do not copy it into this repository or modify it in place.
- Root-level `settings.json` may reference external packages, but downloaded package contents and caches are runtime state, not source assets for this repository.
- If I intentionally adopt external material, record its origin and make that ownership change explicit before bringing it into this repository.

## Layout

- `extensions/`, `skills/`, and `commands/` contain reusable internal assets.
- `support/` contains shared implementation code used by those assets.
- `tests/` contains all tests. Do not place tests in `extensions/` or alongside reusable source assets.
- This repository can be linked directly to `~/.pi/agent`; reusable assets and Pi runtime configuration therefore live at the repository root. Do not put credentials, sessions, trust state, logs, package caches, or installed dependencies in the canonical source tree.
- `projects/pi-mono/.pi/` holds Pi-mono-specific project configuration; it is not linked into the global agent directory by default. External skills remain outside this tree.

Preserve provenance and project scope when organizing assets. Do not silently turn project-local configuration into global configuration.

## Personal Agent Instructions

- Keep answers concise and technical; avoid filler.
- Answer questions before starting implementation.
- When responding to feedback or an analysis, explicitly say whether you agree or disagree.
- Follow each repository's `AGENTS.md` and documented commands.
- don't write to `README.md`, `CHANGELOG.md` or other doc files without specific instructions.
