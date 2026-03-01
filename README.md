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
- Container manager enforces templates, resource limits, and time-based teardown.

## Key Runtime IPC Methods
- Health: `test.ping`
- Container: `container.create`, `container.destroy`, `container.state`
- Session/TDD: `session.get`, `session.*`
- Security: `tool.authorize`, `policy.evaluate`, `policy.load_yaml`, `token.issue`, `token.revoke`
- Audit: `audit.verify`

## Quick Verify
```bash
npm run build
npm test
```
