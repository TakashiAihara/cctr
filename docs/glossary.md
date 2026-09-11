# Glossary

One word, one meaning. Each entry says where the thing exists so the definition can be checked, not believed.

## Colliding words

- session: two things. Say which
  - transcript session: one JSONL file under `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. What cctr reads. `SessionMeta` in `packages/core/src/types.ts`
  - running session: a Claude Code process. What ccx and herdr manage. cctr never manages one
- agent: two things. Say which
  - agent: cctr's HTTP process on a machine (`cctr agent`, `packages/agent`). One per machine
  - subagent: a Claude Code sidechain (`isSidechain: true`, `agentId`, `<session>/subagents/`). Never called an agent here
- host: two things. Say which
  - host (alias): the name a remote is registered under (`cctr remote add <name>`), and the `host` field on every `SessionMeta`. `local` is this machine
  - hostname: what the machine calls itself, reported in `/meta` as `host`

## Terms

- record: one line of a transcript. `Record` in `packages/core/src/types.ts`; unknown types are kept with `raw`
- source: where transcripts come from. The `Source` interface in `packages/core/src/source.ts`; implementations `LocalSource`, `HttpSource`, `SshSource`
- remote: a registered machine, HTTP or SSH. Stored in `~/.config/cctr/remotes.json`
- token: the per-machine bearer secret the agent requires. `~/.local/state/cctr/token`
- machine id: what identifies a machine across the fleet. hostname unless `CCX_MACHINE` is set
- schema version: `SCHEMA_VERSION` in `packages/core/src/source.ts`; bumped when `SessionMeta` or the record shape changes incompatibly
- action provider: the slot for "do something with this session" (resume, send). Phase 7; none ships with cctr
- redact: hide secrets and PII before output leaves. Default on for export and MCP, off for the CLI
