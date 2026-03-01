# TODO

## Current Status

**Phase**: MVP Implementation  
**Focus**: End-to-end flow (Tool System -> AI Loop -> Orchestrator -> CLI)  
**Last Updated**: 2026-02-28

---

## Completed Milestones

### Foundation & Security
- [x] Bootstrap layer (<500 LOC budget)
- [x] Container manager (Docker runtime + lifecycle + templates + seccomp profiles)
- [x] IPC transport (Unix socket + peer identity verification + length-prefixed protocol)
- [x] Security policy engine (built-in rules + YAML rules + extension sandbox + capability tokens)

### Newly Completed (MVP Plan Phases 1-2)
- [x] Audit Log module (`src/kernel/audit/`)
  - [x] SQLite WAL schema
  - [x] SHA-256 hash chain
  - [x] Buffered write logger (threshold + timer flush)
  - [x] Integrity verification APIs
- [x] TDD State Machine module (`src/kernel/state/`)
  - [x] strict / explore / debug modes
  - [x] transition guards and invalid transition handling
  - [x] tool gate checks (`isToolAllowed`)
  - [x] exempt file and test file pattern logic
  - [x] SQLite state snapshot store

---

## MVP Critical Decisions (Pending)

- [ ] D1: TDD enforcement strictness final confirmation
  - [ ] A: Strict
  - [x] B: Strict + exemptions (current implementation follows this path)
  - [ ] C: Advisory
- [ ] D2: CLI rendering strategy final confirmation
  - [x] A: Raw Node.js ANSI + readline (recommended)
  - [ ] B: Ink
- [ ] D3: SQLite backend finalization for audit/state
  - [x] Current: `node:sqlite` (implemented)
  - [ ] Evaluate migration to `better-sqlite3` before release

---

## Next Up (MVP Path)

### Phase 3: Tool System (Highest Priority)
- [ ] Create `src/kernel/tools/types.ts` (ToolDefinition/ToolCallRequest/ToolCallResult/ToolContext)
- [ ] Create `src/kernel/tools/registry.ts` (register, lookup, AI tool definitions)
- [ ] Create `src/kernel/tools/router.ts`
  - [ ] state gate integration (`TddStateMachine.isToolAllowed`)
  - [ ] policy gate integration (`PolicyEngine.evaluate`)
  - [ ] audit logging integration (`AuditLogger.log`)
  - [ ] execution split: `fast_path` vs `sandbox`
- [ ] Implement built-in tools
  - [ ] `builtin/fs.ts`: `fs.read`, `fs.write`, `fs.list`, `fs.exists`
  - [ ] `builtin/search.ts`: `search.grep`, `search.glob`
  - [ ] `builtin/test.ts`: `test.run`
  - [ ] `builtin/shell.ts`: `shell.exec`
- [ ] Add router/tool tests
  - [ ] tool registration + lookup
  - [ ] blocked by state machine
  - [ ] denied by policy
  - [ ] fast-path success path
  - [ ] sandbox tool execution path

### Phase 4: AI Loop
- [ ] Refactor `src/kernel/ai/` unified types + normalizer
- [ ] Complete OpenAI adapter (stream + tool_call normalization)
- [ ] Complete Anthropic adapter (stream + tool_call normalization)
- [ ] Implement `loop.ts` (prompt -> tool calls -> state transitions)
- [ ] Implement context/token budget management

### Phase 5: Kernel Orchestrator
- [ ] Build orchestrator to connect IPC, tools, state, audit, AI loop
- [ ] Session lifecycle: create/run/close
- [ ] Error routing and retry boundaries

### Phase 6: CLI (MVP)
- [ ] `fluffy "<task>"` single-command flow
- [ ] streaming output rendering
- [ ] minimal status line and final summary

---

## Reliability, Testing, Docs (MVP)

- [ ] Fix existing sandbox-dependent test failures in restricted environments (`ipc/transport`, `security/extension`)
- [ ] Add end-to-end happy path test:
  - [ ] prompt -> test file created -> failing test -> code -> passing test -> done
- [ ] Add audit integrity startup check in kernel boot path
- [ ] Add minimal operator docs:
  - [ ] local runbook
  - [ ] policy + audit quick reference
  - [ ] troubleshooting for Docker/socket permissions

---

## Post-MVP / Future Tasks

### v2 Candidate Features
- [ ] Podman adapter
- [ ] network proxy + host allowlist
- [ ] plugin system and plugin SDK
- [ ] multi-session resume
- [ ] output volume pool + image pre-cache optimization
- [ ] meta-policy hot reload

### Long-term Enhancements
- [ ] central plugin registry
- [ ] distributed/multi-machine deployment
- [ ] stronger tamper-evidence model (TPM / remote trust anchor)
- [ ] dynamic priority scheduler
- [ ] on-demand L2 context loading

---

## Engineering Targets

- [ ] Bootstrap LOC budget remains < 500
- [ ] Sandbox creation target: 200-300ms
- [ ] Tool call overhead target: <50ms (fast path)
- [ ] All write operations go through isolated sandbox path
