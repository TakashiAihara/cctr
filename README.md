# cctr

Claude Code transcripts, as data. `cctr` reads the session JSONL that Claude Code writes under `~/.claude/projects/` and gives you the same view of it from a CLI, an MCP server, a Web UI, and a TUI — on this machine and on every other machine you register.

It is the successor of [cchist](https://github.com/TakashiAihara/cchist) and will fold into [ccx](https://github.com/TakashiAihara/ccx). The roadmap is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/cctr/main/scripts/install.sh | sh
```

The binary embeds its runtime; nothing else is needed. `CCTR_INSTALL_DIR` picks the destination (default `~/.local/bin`), `CCTR_VERSION` pins a tag. The installer verifies the release checksum and refuses to install without it.

From source (needs [Bun](https://bun.sh)):

```bash
git clone https://github.com/TakashiAihara/cctr && cd cctr
bun install
bun run install:local
```

## Usage

Output is JSON unless you ask for a table. stdout is data, stderr is log.

```bash
cctr sessions list                       # newest first
cctr sessions list --format table --limit 10
cctr sessions list --local               # only sessions run in $PWD
cctr sessions latest --format id         # bare id, for $(...); latest = most recently modified file
cctr sessions get <id|prefix|latest>     # one session's metadata
cctr sessions records <id>               # the raw transcript, NDJSON
cctr path <id>                           # the cwd it ran in, for cd "$(cctr path latest)"
cctr meta                                # what this cctr knows about itself
```

### Other machines

Register a machine once, then read it like the local one. Two ways to reach it:

```bash
# over SSH: runs that machine's cctr and streams the JSON back. No port, no token.
cctr remote add pi --ssh user@pi

# over HTTP: talks to that machine's `cctr agent`. Needs its token.
cctr remote add mac --url http://mac.local:7411 --token "$(ssh mac cctr agent token)"

cctr remote list
cctr remote check                        # who answers
```

Then:

```bash
cctr sessions list --host all            # this machine plus every remote
cctr sessions list --host pi,mac
cctr sessions get pi:<id>                # host:id pins a machine
cctr sessions records mac:latest
```

One host being down is reported on stderr; the others still answer.

### The agent

`cctr agent` is the HTTP process another machine reads this one through. It is only needed for HTTP remotes; SSH remotes and the local CLI read the files directly.

```bash
cctr agent start                         # background, 127.0.0.1:7411
cctr agent start --bind 0.0.0.0 --port 7411   # reachable from the network; the token still gates every request
cctr agent status
cctr agent token                         # what a remote needs for --token
cctr agent stop
```

The token is one per host, kept in `~/.local/state/cctr/token` (mode 600). Remotes are kept in `~/.config/cctr/remotes.json` (mode 600).

The wire contract is `TranscriptService` (Connect + protobuf, `packages/proto/cctr/v1/transcripts.proto`), the same arrangement ccx uses, so it can move there unchanged. Every procedure is read-only and behind `Authorization: Bearer <token>`. Connect speaks JSON too, so `curl` works:

```bash
curl -X POST -H "Authorization: Bearer $(cctr agent token)" -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:7411/cctr.v1.TranscriptService/GetMeta
```

| Procedure | Returns |
|---|---|
| `GetMeta` | name, version, schema version, machine, projects dir, pid |
| `ListSessions` (`cwd`, `since`, `limit`) | sessions, newest first |
| `GetSession` (`id`) | one session; `NotFound` if none |
| `ReadRecords` (`id`) | the transcript, one JSONL line per streamed message |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage |
| 3 | not found |

## Environment

| Variable | Effect |
|---|---|
| `CCTR_PROJECTS_DIR` | where the session JSONL lives (default `~/.claude/projects`; `CLAUDE_PROJECTS_DIR` is honoured too) |
| `CCTR_CONFIG_DIR` | remotes (default `$XDG_CONFIG_HOME/cctr`) |
| `CCTR_STATE_DIR` | agent state and token (default `$XDG_STATE_HOME/cctr`) |

## Development

```bash
bun install
bun test
bun run typecheck
bun run build          # ./cctr
```

Layout: `packages/proto` (the Connect contract; regenerate with `buf generate packages/proto --template packages/proto/buf.gen.ts.yaml -o packages/proto`), `packages/core` (parser, session model, sources: local / HTTP / SSH), `packages/agent` (TranscriptService on Hono), `apps/cli`.

## License

MIT
