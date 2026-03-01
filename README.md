# Fluffy Waffle
**Goal**: Start thinking from first principles and develop an AI programming command-line tool that is zero-trust, zero-compromise, containerized, and vendor-agnostic.

## 10 Core Principles
1. Human judgment is a valuable resource.
2. The person directing the AI may not be reliable.
3. AI outputs should not be fully trusted.
4. AI must have a deep understanding of the codebase.
5. Writing code before testing is pointless.
6. Version control is essential.
7. Refactoring is an ongoing process; there's no need to overthink it.
8. Containerization is the trend, enabling both environment isolation and seamless cloud migration.
9. Communication inevitably leads to information loss and misunderstandings.
10. Maintaining constructive criticism helps refine proposals.

## Development Plan (README-aligned)

### Phase 1: Foundation reliability ✅
- Build pipeline must be strict-mode TypeScript clean.
- Unit tests must fully pass before release.
- Result: `npm run build` and `npm test` both pass.

### Phase 2: Zero-trust enforcement loop ✅
- Add a dedicated IPC method `tool.authorize` for tool execution gating.
- High-risk tools (`fs.write`, `shell.exec`) are blocked unless policy allows.
- Built-in protected paths (`.fluffy/*`, `src/bootstrap/**`, `src/kernel/**`) are enforced by policy engine.

### Phase 3: “Test before code” workflow in runtime ✅
- Persist and restore session state via SQLite (`.fluffy/state.db`).
- Expose strict state transitions via `session.*` IPC methods:
  - `session.submit_task`, `session.complete_planning`, `session.register_test_file`,
  - `session.complete_test_writing`, `session.report_test_result`, `session.complete_coding`.
- Enforce mode-aware tool access with `strict | explore | debug`.

### Phase 4: Audit and tamper-evidence ✅
- Structured audit logging to SQLite (`.fluffy/audit.db`).
- Hash-chain integrity checks via `audit.verify`.
- IPC dispatch now writes success/failure audit events.

### Phase 5: Vendor-agnostic AI adapter layer ✅
- OpenAI + Anthropic adapter interfaces are unified by `AIProviderAdapter`.
- Provider factory supports environment-driven selection.

### Phase 6: Containerized kernel runtime ✅
- Bootstrap starts kernel inside container runtime (`docker` / `podman` detection).
- Bootstrap and kernel socket paths are now aligned through `FLUFFY_KERNEL_SOCKET`.
- Host/container IPC now uses a bind-mounted directory (`.fluffy/ipc`) for reliable health checks.
- Container manager enforces templates, resource limits, and time-based teardown.

## MVP Status (2026-03-01)
- Core runtime is available: build/test are green, runtime entrypoints are connected, and CLI access is available.
- Security hardening and test-depth expansion are in progress for production readiness.
- Container runtime interface (`pause`, `resume`, `run`, `logs`) is exposed through IPC.
- A user-facing CLI entrypoint (`fluffy` / `fluffy-cli`) is available for kernel RPC and core workflows.

## Key Runtime IPC Methods
- Health: `test.ping`
- Container: `container.create`, `container.destroy`, `container.state`, `container.pause`, `container.resume`, `container.exec`, `container.logs`
- Session/TDD: `session.get`, `session.*`
- Security: `tool.authorize`, `policy.evaluate`, `policy.load_yaml`, `token.issue`, `token.revoke`
- Audit: `audit.verify`

## CLI (MVP)
Default socket: `.fluffy/ipc/kernel.sock` under current workspace (override with `--socket` or `FLUFFY_KERNEL_SOCKET`).

Security notes:
- `debug` mode must be explicitly enabled through `session.set_mode`.
- CLI warns when the socket parent directory is world-writable (for example `/tmp`).

```bash
# generic rpc
npm run start:cli -- rpc test.ping

# session lifecycle
npm run start:cli -- session submit-task
npm run start:cli -- session complete-planning

# tool authorization
npm run start:cli -- tool-authorize fs.write src/app.ts

# container operations
npm run start:cli -- container state fw-sandbox-1
npm run start:cli -- container exec fw-sandbox-1 '["echo","hello"]'
```

## Quick Verify
```bash
npm run build
npm test
npm run start:kernel &
KERNEL_PID=$!
npm run start:cli -- ping
kill $KERNEL_PID
```
