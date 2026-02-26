# Fluffy Waffle Architecture Design Review

## Key Risks

### 1. Nested Container Feasibility

L2 containers run nested inside L1. The document does not discuss known Docker-in-Docker issues (storage driver conflicts, permission model complexity). Podman rootless nesting is slightly better but still has edge cases. This is a foundational assumption of the entire architecture and requires PoC validation.

### 2. SO_PEERCRED Cross-Platform Issue

`SO_PEERCRED` is Linux-only. The document mentions macOS Keychain for key storage, implying cross-platform support is needed, but macOS uses `LOCAL_PEERCRED` with different semantics. The IPC identity verification mechanism needs a platform abstraction layer, which is missing from the document.

### 3. Unrealistic Latency Budget

- Single L2 sandbox creation claims ~200-300ms; actual time including volume creation, mount configuration, and process startup is likely 500ms-1s+
- A single read -> write -> test tool chain may accumulate 1-2s of pure container overhead
- 50ms per tool call end-to-end budget is very tight after IPC + policy check + sandbox routing
- Deno policy sandbox 100ms timeout -- JIT warmup may exceed this on first evaluation

### 4. Missing Degradation Strategy Without Container Runtime

The entire system hard-depends on Docker/Podman. Completely unusable in environments without containers (Docker-less CI, restricted enterprise environments, certain WSL configurations). No fallback mode exists.

### 5. Output Volume Efficiency

Sandbox writes complete files to output volume, then kernel computes diff. For large files, this means copying the entire file just to change a few lines. Diff computation adds latency. Producing patches/diffs directly would be more efficient.

## Design Concerns

### 6. Strict Mode TDD Practicality Boundaries

The state machine enforces "must have failing tests before writing code", but the following scenarios are not covered:

- Configuration file modifications (no meaningful unit tests)
- Pure type refactoring (behavior unchanged, tests already pass)
- Documentation updates

The document says refactoring uses explore mode, but this is more of a workaround than a solution.

### 7. Tech Debt Budget Can Be Gamed

5 unverified commit limit, write 1 passing test to recover 1 budget point. What counts as a "passing test"? An `expect(true).toBe(true)` can recover budget, and the system cannot distinguish meaningful tests from trivial ones.

### 8. Incomplete Context Management Strategy

The document details token budget for tool descriptions (~500-3000 tokens), but conversation context (code file contents, test output, error messages) is the real token consumer. No conversation history compression/summarization strategy is described.

### 9. Bootstrap < 500 LOC Constraint May Be Unrealistic

Configuration reading + container startup (with security flags) + health check (with retries) + crash recovery in TypeScript will likely exceed 500 lines. Prototype validation of this constraint is recommended.

## Missing Critical Content

### 10. Error Recovery Paths

The document describes the happy path, but recovery strategies for the following scenarios are weak:

- L1 container crashes mid-operation
- SQLite database corruption (audit log + state machine + session all in one DB)
- Output volume merge partial failure
- Kernel process OOM

### 11. IPC Wire Protocol Undefined

Unix socket is mentioned but serialization format is not specified (JSON? Protobuf? MessagePack?). This directly impacts the feasibility of the 50ms latency budget. JSON parsing overhead is non-negligible under high-frequency calls.

### 12. Seccomp "standard" Profile Test Limitations

Allows `execve` but prohibits `AF_INET/AF_INET6`, meaning tests running in code-executor cannot make network requests. Integration tests and API tests will fail outright. The document does not discuss this tradeoff.

### 13. Plugin Syscall Interface Versioning

"Kernel supports the latest 2 versions" -- but version definition of the syscall interface, what constitutes a breaking change, and version negotiation mechanism are all unspecified.

## Positive Design Aspects

- **Clear Trust Model**: TCB boundary is well-defined; "analyze starting from compromise of components outside TCB" is correct security thinking
- **Policy Evaluation Semantics**: Order-independent, deny-first, default-deny -- unambiguous semantics
- **26 Policy Test Cases**: As normative test specifications, they cover boundary cases well
- **Capability Token Fast Path**: Valid token skips YAML/Extension evaluation -- reasonable performance optimization
- **Idempotent CLEANUP Design**: Each step runs independently; single-step failure does not block subsequent steps
- **Meta-Policy Trial Run**: Replaying last 100 audit entries against new rules to verify impact is practical and safe

## Priority Recommendations

| Priority | Item | Description |
|----------|------|-------------|
| P0 | Nested container PoC | Validate foundational architecture assumption |
| P0 | SO_PEERCRED cross-platform | Design platform abstraction for IPC identity |
| P1 | End-to-end latency benchmark | Validate 50ms/200ms budget |
| P1 | IPC wire protocol | Define serialization format |
| P1 | Error recovery strategy | Supplement recovery paths |
| P2 | Container-less degradation | Design fallback mode |
| P2 | Context management | Conversation history strategy |
