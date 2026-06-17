# pi-conf

Personal Pi harness configuration and experiments.

This is built for how I use Pi. It contains local assumptions, absolute-ish workflows, and preferences that probably will not work unchanged for anyone else.

## Layout

- `src/` - development area for local Pi extensions and shared code.
- `agent/` - my Pi agent configuration tree. This is intentionally not part of the initial committed baseline while I decide what belongs here.
- `justfile` - local maintenance commands for linking extensions and wiring this checkout into Pi.

## Workflow

I keep extension source in `src/extensions` and symlink runnable extensions into `agent/extensions`:

```sh
just refresh
```

For local development I can also point Pi at this repo's agent directory:

```sh
just link-agent
```

By default that links to `$HOME/.pi/agent`. Override with `PI_AGENT_DIR` if needed:

```sh
PI_AGENT_DIR=/path/to/agent just link-agent
```
