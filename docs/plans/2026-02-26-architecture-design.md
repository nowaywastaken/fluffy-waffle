# Fluffy Waffle Architecture Design

## Overview

Fluffy Waffle is a vendor-agnostic AI programming CLI tool built on a zero-trust model with multi-layer container isolation. It enforces TDD discipline at the system level and provides a fully pluggable architecture where all external dependencies (AI providers, container runtimes, VCS, tools) are replaceable through adapter interfaces.

## Core Principles

1. **Full zero-trust**: All participants (AI, human, external services) are untrusted. Every input/output is validated.
2. **Multi-layer container isolation**: Development environment runs in L1 container; AI operations run in nested L2 sandboxes.
3. **System-enforced TDD**: The state machine enforces test-first workflow. AI cannot write source code before tests exist and have been executed.
4. **Pluggable everything**: AI providers, container runtimes, VCS, tools -- all replaceable through plugin interfaces.
5. **Context-efficient AI interaction**: Uses native Function Calling instead of MCP to avoid context window bloat.

## Technology Stack

- **Language**: TypeScript
- **Policy sandbox runtime**: Deno (for fine-grained permission control)
- **Container runtime**: Docker/Podman (abstracted via ContainerRuntime interface)
- **Storage**: SQLite (WAL mode) for audit log, state machine, sessions
- **IPC**: Unix socket with `SO_PEERCRED` identity verification
- **License**: MIT

## Trust Model

### Trusted Computing Base (TCB)

The following components are assumed to be trustworthy. If any is compromised, the entire security model is invalidated:

1. Host machine OS
2. Bootstrap binary
3. Container runtime (Docker/Podman)

All security analysis starts from "what happens when a component OUTSIDE the TCB is compromised."

## System Architecture

```
+--[ Host Machine ]------------------------------------------+
|  Bootstrap (< 500 LOC, trust anchor)                       |
|    |                                                        |
|  +--[ L1: Workspace Container ]---------------------------+|
|  |                                                         ||
|  |  Kernel Process (non-root, event loop + workers)        ||
|  |    +-- Security Policy ----+                            ||
|  |    |   [Token Issuer]      |                            ||
|  |    |   [Policy Rules]      |                            ||
|  |    |   [Capability Store]  |                            ||
|  |    +-----------------------+                            ||
|  |    +-- Container Manager                                ||
|  |    +-- Scheduler (thread pool)                          ||
|  |    +-- Audit Log (append-only, chained hash)            ||
|  |    +-- State Machine (SQLite, chained hash)             ||
|  |    |                                                    ||
|  |    +-- Unix Socket (created in L1, bind mount to L2)   ||
|  |          |                                              ||
|  |          | 1. Plugin requests capability                ||
|  |          | 2. Kernel: policy check + issue token        ||
|  |          |    (bound to container_id + l1_pid)          ||
|  |          | 3. Plugin: exec with token                   ||
|  |          | 4. Kernel: validate token (O(1)) + execute   ||
|  |          | 5. Audit log records all steps               ||
|  |          |                                              ||
|  |  +--[ L2: Sandbox A ]----+  +--[ L2: Sandbox B ]-----+ ||
|  |  | AI Provider Plugin    |  | Tool Plugin             | ||
|  |  | cap: ai.generate      |  | cap: fs.read(/src/**)   | ||
|  |  | (no fs, limited net)  |  | (ro mount, no net)      | ||
|  |  +-----------------------+  +-------------------------+ ||
|  |                                                         ||
|  |  Project Dir (rw by kernel, ro bind mount to L2)        ||
|  +---------------------------------------------------------+|
+-------------------------------------------------------------+
```

### Three-Layer Separation

**User Space (Plugins)**: All replaceable external components. Cannot access system resources directly; must go through syscall interface.

**Kernel**: Five core modules -- Security Policy, Container Manager, Scheduler, Audit Log, State Machine. Runs as a non-root process in L1.

**Hardware Abstraction**: Multiple independent adapter interfaces (ContainerRuntime, FileSystem, NetworkPolicy, ProcessManager). No unified HAL -- each adapter has its own abstraction granularity.

### Bootstrap Layer

Bootstrap exists outside the kernel. Its sole responsibilities:

1. Read configuration
2. Start the kernel container (L1)
3. Health check (ping/pong)
4. Restart kernel on crash

Code budget: < 500 LOC. No IPC message handling, no business data parsing, no network ports. If bootstrap code exceeds this budget, responsibilities have leaked.

### Container Layers

**L1 (Workspace Container)**:
- User's development environment
- Project directory mounted read-write
- Network access (policy-restricted)
- Kernel process runs here
- Lifetime = one development session

**L2 (Execution Sandbox)**:
- AI operation sandbox, nested inside L1
- Project directory mounted read-only; output written to temporary volume
- No network access (unless policy explicitly allows via application-layer proxy)
- Lifetime = single operation or atomic operation group
- Output reviewed before merging back to L1

Security boundary: L2 cannot modify L1's filesystem. It can only produce diffs. Merge action is performed by the kernel in L1, after policy check.

## Security Policy Module

### Core Principles

1. **Default-deny**: Operations without an explicit `allow` rule are rejected.
2. **Deny takes priority**: Any rule's `deny` is terminal and cannot be overridden.
3. **Allow requires consensus**: An operation is allowed only if at least one rule explicitly allows it AND no rule denies it.
4. **Order-independent semantics**: The final result does not depend on evaluation order. Built-in -> YAML -> Extension ordering is a performance optimization (deny short-circuits earlier), not a semantic requirement.

### Rule Evaluation Engine

```
function handleSyscall(syscall):
  // Phase 0: Built-in rules (always first, non-negotiable)
  for rule in builtinRules:
    decision = rule.evaluate(syscall)
    if decision == DENY: return DENY (terminal)
    collect allow/require_review

  // Fast path: valid capability token skips YAML + Extension
  if syscall.token is valid:
    if built-in require_review collected: return REQUIRE_REVIEW
    return ALLOW

  // Slow path: YAML rules
  for rule in yamlRules.findMatching(syscall.type):  // O(1) hash lookup
    decision = rule.evaluate(syscall)
    if decision == DENY: return DENY (terminal)
    collect allow/require_review

  // Slow path: Extension rules (TypeScript in Deno L2 sandbox)
  for rule in extensionRules:
    decision = rule.evaluate(syscall)
    if decision == DENY: return DENY (terminal)
    collect allow/require_review

  // Final decision
  if any require_review: return REQUIRE_REVIEW
  if any allow: return ALLOW
  return DENY("no rule explicitly allowed this operation")
```

### Policy Decision Types

- `allow`: Explicit authorization. Does NOT short-circuit (subsequent rules can still deny or require_review).
- `deny`: Explicit rejection. Immediately short-circuits. Terminal.
- `pass`: Abstain. No effect on result.
- `require_review`: Requires human review. Takes priority over allow, but not over deny.

### Rule Language: Declarative YAML + TypeScript Extensions

**YAML layer** (covers 90% of scenarios):

```yaml
capabilities:
  - name: "fs-write-source"
    match: { syscall: "fs.write", path_glob: ["src/**", "tests/**"] }
    action: allow
    constraints:
      require_sandbox: L2
      require_capability_token: true
      max_file_size: "100KiB"

  - name: "fs-write-sensitive"
    match: { syscall: "fs.write", path_glob: ["package.json", "Dockerfile", ".github/**"] }
    action: require_review
    reason: "Sensitive file modification requires review"
```

**Match semantics**:
- Multiple fields within `match`: AND (all conditions must be satisfied)
- Multiple values within array fields: OR (match any one)
- Glob semantics: aligned with `.gitignore` (using picomatch). `**` matches zero or more path segments. Exclude takes priority over include.

**Except mechanism** for require_review rules:

```yaml
  - name: "new-employee-review"
    match: { syscall: "fs.write", caller_tag: ["new_employee"] }
    action: require_review
    except:
      - { path_glob: ["src/tests/**"] }
      - { caller_tag: ["trusted_write"] }
```

`except` uses the same condition types as `match`. If syscall matches both `match` and any `except` item, the rule returns `pass`.

**TypeScript extension layer** (covers remaining 10%):

Executed in a dedicated long-running Deno L2 sandbox with `--allow-read=/run/fluffy/policy.sock --allow-write=/run/fluffy/policy.sock`. Pre-loaded at kernel startup. Timeout per evaluation: 100ms. If sandbox crashes, fallback to default-deny.

### Capability System

**Capability Token** (short-term, operation-level):
- Bound to `(container_id, l1_pid)` pair
- Scoped: syscall type + path glob + maxOps + TTL (default 30s)
- Contains monotonic nonce for replay prevention
- Validated via `SO_PEERCRED` matching
- Bypasses YAML and Extension rules; built-in rules always execute

**Capability Tag** (long-term, identity-level):
- Attached to PluginIdentity at registration
- Represents trust level: `core_plugin`, `trusted_write`, `third_party`
- Visible in all evaluation paths (match and except conditions)

### Built-in Rules (hardcoded, max 10)

1. Meta-policy protection (policy files cannot be modified via fs.write)
2. Bootstrap file protection
3. Kernel process file protection
4. Audit log protection
5. State machine DB protection

### Meta-Policy

Policy file updates use a dedicated `policy.update` syscall (not `fs.write`). Always requires human review. Atomic update via rename:

1. User submits new policy content via CLI
2. Built-in rule enforces require_review
3. Kernel validates new policy in memory
4. Trial run: replay last 100 audit entries against new rules, show only changed results
5. Breaking changes (allow->deny) marked as `[BREAKING]`; >5 breaking changes require confirmation phrase
6. Write to temp file, atomic rename, reload rules

### Unit Specifications (no ambiguity)

- Size: IEC binary (`KiB`, `MiB`, `GiB`) and SI decimal (`KB`, `MB`, `GB`). Case-sensitive. Pure numbers = bytes.
- Time: `s`, `ms`, `m`, `h`. Case-sensitive.
- Parse errors at kernel startup block startup. No guessing.

### Performance Optimization

- YAML rules indexed by `HashMap<syscall_type, Rule[]>` -- O(1) lookup
- Glob patterns pre-compiled to RegExp at rule load time
- Built-in rules: max 10, always fast

## Policy Engine Test Specifications (26 cases)

These test cases serve as the normative specification for the policy evaluation engine.

### Basic Semantics (1-6)

1. No rules match -> default deny
2. Only pass rules -> default deny
3. One allow + one deny (same syscall) -> deny wins
4. One allow + one require_review -> require_review wins
5. Deny in extension layer, allow in built-in layer -> deny wins (verifies allow does not short-circuit)
6. require_review with except, syscall matches except -> pass

### Token Path (7-9, 21-23)

7. Valid token + built-in deny -> deny (token does not bypass built-in)
8. Valid token + no built-in issues -> allow (token bypasses YAML/Extension)
9. Expired token -> fall through to full evaluation
21. Token maxOps exhausted -> invalid, fall through
22. Token TTL boundary race -> use time snapshot at evaluation start, no TOCTOU
23. Token container_id mismatch -> invalid

### Except Mechanism (13-15, 26)

13. require_review + except does not match -> require_review
14. require_review + except with multiple conditions, one matches -> pass
15. require_review + except with multiple conditions, none match -> require_review
26. match and except conditions identical -> rule never triggers, schema warning

### Aggregation Behavior (10-12, 16-17)

10. Multiple require_review rules -> all reasons aggregated
11. YAML deny + Extension allow -> deny (short-circuit, Extension never executes)
12. Partial match (syscall matches but path_glob does not) -> rule does not apply
16. Multiple allow rules, no deny/review -> allow
17. Cross-layer allow (YAML + Extension) -> allow

### Defensive Boundaries (18-20, 24-25)

18. Built-in rules empty (should not happen, defensive test) -> system still works
19. YAML rules file empty -> default deny (only built-in rules active)
20. Extension sandbox crashes -> default deny + restart attempt
24. Unknown syscall type (no rules match) -> default deny
25. path_glob is empty array -> matches no paths, schema warning

## Container Manager Module

### Responsibilities

Container Manager only does three things:

1. **Create** L2 sandboxes (per policy-required security configuration)
2. **Monitor** L2 sandboxes (health check, resource limits, timeout)
3. **Destroy** L2 sandboxes (on completion or abnormal termination)

It does NOT: decide whether to allow sandbox creation (Security Policy's job), manage L1 container (Bootstrap's job), or handle business logic inside sandboxes (Plugin's job).

### Lifecycle State Machine

```
CREATING --[success]--> RUNNING --[normal]---> STOPPING --> CLEANUP --> DESTROYED
    |                      |
    | [failure]            | [abnormal: timeout/OOM/crash]
    v                      v
  FAILED ---------> CLEANUP --> DESTROYED
```

**Design constraint**: CLEANUP is idempotent. Each step (stop, remove container, remove volume, remove temp files) runs independently; single-step failure does not block subsequent steps. Background garbage collector scans for orphan resources.

### Sandbox Configuration

```typescript
interface SandboxConfig {
  plugin_name: string;
  container_id: string;
  mounts: Mount[];
  output_volume: string;
  network_mode: "none" | "restricted";
  allowed_hosts?: string[];       // only if "restricted", references policy.yaml whitelist group
  memory_limit: string;           // IEC units, e.g. "512MiB"
  cpu_limit: number;
  max_pids: number;               // default 100 for code-executor
  max_duration: number;           // ms
  seccomp_profile: "strict" | "standard";
}
// Hardcoded (not configurable): no_new_privileges=true, read_only_rootfs=true, non-root user
```

**Seccomp profiles**:
- `strict`: Basic computation + IPC only (read, write, close, mmap, futex, socket AF_UNIX, etc.). No fork, no process spawning, no network sockets. For policy sandbox and AI provider.
- `standard`: Additionally allows fork, clone (no CLONE_NEWUSER/CLONE_NEWNS), execve, open, unlink, mkdir, pipe, etc. For code running and test running. Still prohibits ptrace, mount, chroot, setuid, AF_INET/AF_INET6.

File path access control is provided by container mount configuration, NOT by seccomp (seccomp cannot filter path strings).

### Sandbox Templates

**ai-provider**: network_mode=restricted (via application-layer proxy), memory=256MiB, cpu=0.5, max_pids=10, max_duration=120s, seccomp=strict

**code-executor**: network_mode=none, memory=1GiB, cpu=1.0, max_pids=100, max_duration=300s, seccomp=standard

**policy-sandbox**: network_mode=none, memory=128MiB, cpu=0.25, max_pids=5, max_duration=100ms, seccomp=strict

### Network Isolation: Application-Layer Proxy

For `network_mode: restricted` sandboxes (AI provider):

- Kernel runs a lightweight HTTP/HTTPS forward proxy listening on Unix socket
- Sandbox accesses proxy via bind-mounted socket
- Inside sandbox: `socat` provides TCP-to-Unix-socket forwarding for standard HTTP_PROXY compatibility
- Proxy checks Host header against whitelist (from policy.yaml `network_whitelist` section)
- CONNECT tunnel only (no TLS termination) -- proxy sees target domain and port, not request content
- All requests logged to audit log
- socat only started in templates that need network proxy (not in policy-sandbox)

### Container Runtime Abstraction

```typescript
interface ContainerRuntime {
  create(config: SandboxConfig): Promise<ContainerId>;
  start(id: ContainerId): Promise<void>;
  stop(id: ContainerId, timeout: number): Promise<void>;
  kill(id: ContainerId): Promise<void>;
  remove(id: ContainerId): Promise<void>;
  inspect(id: ContainerId): Promise<ContainerState>;
  pause(id: ContainerId): Promise<void>;
  resume(id: ContainerId): Promise<void>;
  run(id: ContainerId, command: string[], opts: RunOptions): Promise<RunResult>;
  logs(id: ContainerId, opts: LogOptions): AsyncIterable<string>;
  createVolume(name: string): Promise<VolumeId>;
  removeVolume(id: VolumeId): Promise<void>;
  ping(): Promise<boolean>;
}
```

The `run` method is denied by default policy. Only allowed in debug mode with require_review.

### Performance: Image Pre-caching (not container pooling)

Container pooling (pre-creating containers) is not feasible because Docker/Podman do not support adding bind mounts after container creation.

Instead:
1. Pre-pull all template images at kernel startup (async, non-blocking)
2. Pre-compile seccomp profiles
3. Pre-create output volumes
4. Container creation with cached image: ~200-300ms

If image not ready when sandbox requested: return `{ status: "pending", reason: "image downloading", progress: "45%" }`.

### Output Extraction and Merge

1. Sandbox writes output to output volume (complete files, not diffs)
2. Kernel extracts output from volume
3. Kernel computes diff against project directory (using reliable diff algorithm)
4. Policy check on merge (auto-merge criteria: tests pass, no sensitive files, diff < threshold)
5. Human review triggers: sensitive file paths, large diffs, policy rules
6. Approved: kernel applies diff to project directory. Rejected: output discarded.
7. Output volume destroyed (new volume created for next sandbox, never reused)

### Design Constraints

- Sandbox resource configuration is immutable after creation. To adjust: destroy and recreate with new config. Output volume can be carried over (after kernel validation).
- Sandbox system time synchronized with L1. No independent time namespace.
- `allowed_hosts` configuration lives in policy.yaml, changes go through `policy.update` mechanism.

## Scheduler Module

### Responsibilities

1. Receive task requests, enqueue
2. Determine execution order based on priority and resource availability
3. Manage concurrency limits
4. Coordinate with Container Manager for sandbox allocation/reclamation

### Task Model

```typescript
interface Task {
  id: string;
  type: TaskType;          // "ai_generate" | "test_run" | "validate" | "review" | "commit"
  priority: Priority;      // 1 (highest/system) to 5 (idle)
  state: TaskState;        // "queued" | "waiting_dependency" | "running" | "paused" | "completed" | "failed" | "cancelled"
  sandbox_template: "ai-provider" | "code-executor" | "policy-sandbox";
  dependencies: string[];  // task IDs that must complete first
}
```

### Priority Model: Fixed Priority + Starvation Prevention

1. Select highest-priority executable task (all dependencies completed + resources available)
2. Same priority: FIFO
3. Starvation prevention: tasks waiting beyond `age_threshold` get effective priority bumped by one level (max bump to priority 2; never exceeds system tasks at priority 1)
4. Priority 1 system tasks are immune to starvation bumping

No dynamic priority (nice values). Fixed priority + starvation prevention covers all scenarios with minimal complexity.

Priority inversion is not a concern: tasks express ordering via explicit `dependencies`, not shared locks.

### Concurrency Limits

```yaml
scheduler:
  global_max: 4
  per_template:
    ai-provider: 2
    code-executor: 2
    policy-sandbox: 1
```

Rationale: personal developer machine (4-8 cores), AI calls are I/O-bound, test runs are CPU-bound, policy evaluation is single-instance.

### Preemption Strategy

When a high-priority task needs resources but concurrency limit is reached:

```
if low_priority_task.elapsed > max_duration * 0.8:
  WAIT (let it finish, almost done)
elif system_memory_usage > 0.8:
  DESTROY (release resources)
else:
  PAUSE (docker pause, cgroups freezer)
```

Pause handling:
- Kernel sends `PAUSE_SIGNAL` via IPC before pausing (1s grace period for state save)
- On resume: kernel sends `RESUME_SIGNAL`
- If IPC connection times out during pause: reconnect after resume

### Queue Management

- Priority queue (min-heap by priority, FIFO within same priority)
- Dependency graph (DAG) for tracking `waiting_dependency` state
- Running set (currently executing tasks)
- Event-driven scheduling loop (triggered by: new task enqueued / task completed / task failed / resource released)
- Dependency failure propagation: if task B depends on task A and A fails, B transitions to `failed` with reason "dependency failed: A". No automatic retry.

### State Machine Integration

Scheduler is aware of session_mode but does not enforce workflow constraints directly. State Machine expresses constraints through task dependencies:

```
strict mode:
  code_gen_task.dependencies = [test_gen_task]  // enforces test-first

explore mode:
  code_gen_task.dependencies = [plan_task]      // skips test_gen
```

State Machine builds the dependency graph; Scheduler respects it.

## AI Tools Module

### Problem Statement

Current AI coding tools (MCP-based) inject tool descriptions into system prompts, consuming 2000-20000+ tokens of context window as tool count grows. Fluffy Waffle uses native Function Calling instead, keeping tool schemas at the API layer rather than in conversation context.

### Three-Layer Architecture

```
+--[ AI Provider (L2 Sandbox) ]------------------+
|  AI Model <-> Provider-native Function Calling   |
+--------------------------------------------------+
        | (IPC: normalized tool calls)
+--[ Tool Router (Kernel) ]------------------------+
|  Policy check -> Route -> Sanitize -> Return      |
+--------------------------------------------------+
        | (IPC: tool runs in sandbox)
+--[ Tool Plugins (L2 Sandboxes) ]----------------+
|  fs-tool | git-tool | test-tool | search-tool    |
+--------------------------------------------------+
```

### Latency Budget

- Single tool call end-to-end (excluding tool's own work): **50ms max**
- 10 tool calls per round communication overhead: **500ms max**

### Fast Path: Kernel-Native Tools (read-only only)

High-frequency read-only tools run directly in the kernel process, avoiding the second IPC hop:

```
Kernel-native (fast path):  fs.read, search.grep, search.glob, fs.list, fs.exists
Plugin sandbox (full path): fs.write, test.run, git.*, shell.run, custom tools
```

**Architectural invariant**: All write operations go through sandbox isolation. The kernel only performs read-only operations directly.

### Provider Adapter

Unified interface across AI providers (OpenAI, Anthropic, Google):

```typescript
interface AIProviderAdapter {
  name: string;
  formatTools(tools: ToolDefinition[]): ProviderNativeToolFormat;
  chat(messages: Message[], tools: ProviderNativeToolFormat): Promise<AIResponse>;
  chatStream(messages: Message[], tools: ProviderNativeToolFormat): AsyncIterable<StreamEvent>;
  parseToolCalls(response: AIResponse): NormalizedToolCall[];
  formatToolResult(call: NormalizedToolCall, result: ToolResult): ProviderNativeResultFormat;
}

type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; call_id: string; tool_name: string }
  | { type: "tool_call_delta"; call_id: string; arguments_delta: string }
  | { type: "tool_call_end"; call_id: string }
  | { type: "tool_executing"; call_id: string; tool_name: string; description: string }
  | { type: "tool_result"; call_id: string; summary: string; duration_ms: number }
  | { type: "done" };
```

`tool_executing` and `tool_result` are kernel-emitted events (not from AI provider) for CLI rendering.

### Context Management (v1: Conservative Strategy)

No dynamic/on-demand tool loading in v1. Strategy:

1. All tool names + one-line summaries always loaded (~500 tokens for 50 tools)
2. Full parameter schemas passed via Function Calling API (does not consume conversation context)
3. Token budget: 3000 tokens. If all descriptions exceed budget, trim by context_cost (high first), keeping name + summary only
4. `context_cost` auto-computed by kernel at registration (based on actual token count of description + parameters), not declared by developers

Workflow state communicated via system prompt injection (~30-50 tokens):

```
"Workflow state: test_writing. Writable paths: tests/** only.
 Source code modification available after tests pass."
```

### Parallel Tool Call Handling

- AI returns multiple tool calls in one response -> default parallel
- Simple conflict detection: if any read path overlaps with a write path, or multiple writes to same path -> serialize
- No semantic dependency analysis (too complex, unreliable)

### Output Sanitization

Applied to every tool result before returning to AI. NOT a policy check -- it is output cleansing:

1. Truncate if exceeds `max_result_tokens` (default 4000 tokens). Strategy: tail/head/middle (configurable per tool type)
2. Scan for high-confidence sensitive patterns only (known prefixes: `sk-`, `ghp_`, `gho_`, `AKIA`, `xox-`, `glpat-`, `npm_`). No generic "long random string" detection (too many false positives)
3. User-configurable patterns in policy.yaml
4. Record original + sanitized in audit log

### Tool Unavailability Handling

When AI calls a tool unavailable in current state, return structured error (not "tool not found"):

```typescript
interface ToolUnavailableError {
  error: "tool_unavailable";
  tool_name: string;
  current_state: string;
  reason: string;
  available_tools: string[];
}
```

Two-layer defense: system prompt informs constraints (prevention) + ToolUnavailableError intercepts violations (fallback).

### Retry Strategy

- Read operations (fs.read, search.*): auto-retry once (100ms delay), transparent to AI
- Write operations (fs.write, git.commit): no auto-retry, return error to AI with `retryable: true/false`
- All retries recorded in audit log

### TDD Integration via State Machine

State Machine controls tool availability per workflow state:

| State | Writable | Restricted |
|-------|----------|------------|
| test_writing | tests/** | src/** (denied) |
| code_writing | src/** | tests/** (read-only) |
| validating | nothing | all writes denied |

Enforcement through Security Policy rules that include `state_machine_state` in match conditions.

### Tool Plugin SDK

```typescript
interface ToolPlugin {
  name: string;
  version: number;
  tools(): ToolDefinition[];
  handlers(): Record<string, ToolHandler>;
}

interface ToolContext {
  run(command: string[], opts?: RunOpts): Promise<RunResult>;  // array form only, no shell
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;     // output volume only
  listDir(path: string): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  env: Readonly<Record<string, string>>;
  sandboxId: string;
  pluginName: string;
  sessionMode: "strict" | "explore" | "debug";
}
```

All ToolContext methods are constrained by sandbox mount configuration. SDK documentation emphasizes: always use array form for command arguments.

## Audit Log Module

### Record Format

```typescript
interface AuditEntry {
  id: string;                      // monotonic, unique
  timestamp: number;               // ms since epoch
  prev_hash: string;               // chain integrity
  hash: string;                    // SHA-256
  event_type: AuditEventType;
  syscall_type?: string;
  tool_name?: string;
  caller: PluginIdentity | "kernel" | "user";
  session_mode: SessionMode;
  state_machine_state: string;
  policy_decision: "allowed" | "denied" | "review_required" | "allowed_by_token";
  policy_rule_name?: string;
  capability_id?: string;
  deny_reason?: string;
  input_summary: string;           // truncated to 500 chars, sanitized via OutputSanitizer
  output_summary?: string;         // truncated to 500 chars, sanitized
  duration_ms?: number;
  sandbox_id?: string;
  metadata?: Record<string, string>;  // includes output_volume_path for full content reference
}
```

Event types: `syscall`, `tool_execute`, `tool_result`, `state_transition`, `policy_update`, `session_mode_change`, `sandbox_created`, `sandbox_destroyed`, `sandbox_failed`, `capability_issued`, `capability_expired`, `merge_approved`, `merge_rejected`, `kernel_start`, `kernel_shutdown`, `audit_storage_warning`, `audit_archive_deleted`.

### Storage

SQLite (WAL mode). Chain integrity: each entry's hash = SHA-256(prev_hash + timestamp + event_type + data). Genesis entry: prev_hash = SHA-256("genesis:" + kernel_start_timestamp). Integrity verified at kernel startup; chain break logged as warning but does not block startup.

### Sync/Async Write Strategy

```typescript
// Security events: synchronous write (wait for SQLite commit)
SYNC_EVENTS: ["policy_update", "merge_approved", "merge_rejected",
              "session_mode_change", "capability_issued"]

// Operational events: async write with buffer
ASYNC_EVENTS: ["syscall", "tool_execute", "tool_result",
               "sandbox_created", "sandbox_destroyed", ...]

BUFFER: { max_size: 100, flush_interval_ms: 500, flush_on_shutdown: true }
```

Crash window: max 500ms of operational events. Security events never lost.

### Retention Policy

```yaml
audit:
  retention_days: 90
  max_size: "1GiB"
  rotation: "daily"
  export_format: "jsonl"
```

Storage warnings: >80% = `audit_storage_warning` event, >95% = `audit_storage_critical`, >100% = delete oldest archive + record `audit_archive_deleted`.

### Chain Integrity Scope

Defends against: accidental corruption and casual tampering. Does NOT defend against: targeted attacks with L1 filesystem write access (would require external trust anchor like TPM or remote audit service, out of scope for v1).

## State Machine Module

### States and Modes

```typescript
type SessionState = "idle" | "planning" | "test_writing" | "code_writing"
  | "validating" | "reviewing" | "committing" | "exploring" | "retroactive_testing";

type SessionMode = "strict" | "explore" | "debug";
```

### Transition Rules

**Strict mode**:
```
idle -> planning                    (user sends message)
planning -> test_writing            (AI calls plan.complete tool)
test_writing -> code_writing        (tests exist AND executed AND at least one fails -- TDD Red phase)
code_writing -> validating          (code changes exist)
validating -> reviewing             (all tests pass)
validating -> code_writing          (tests fail, back to fix)
reviewing -> committing             (merge approved: auto or human)
reviewing -> code_writing           (merge rejected)
committing -> idle                  (commit complete)
```

**Explore mode**:
```
idle -> planning                    (user sends message)
planning -> exploring               (AI calls plan.complete tool)
exploring -> validating             (code changes exist)
validating -> reviewing             (existing tests pass, or no tests)
validating -> exploring             (tests fail)
reviewing -> committing             (merge approved, tagged as unverified)
reviewing -> retroactive_testing    (user chooses to add tests before merge)
retroactive_testing -> validating   (tests written)
committing -> idle                  (commit complete)
```

**Debug mode**: Same as explore, plus `container.run` allowed via require_review.

**Any state -> idle**: User cancels or session reset.

**Refactoring**: v1 uses explore mode for refactoring (tests already pass, no Red phase needed). No special strict-mode refactoring state.

### Transition Guards

```typescript
{ from: "test_writing", to: "code_writing",
  condition: ctx => ctx.testsExist && ctx.testsHaveBeenExecuted && !ctx.allTestsPass,
  on_fail: "Tests must exist, have been run, and at least one must fail (TDD Red phase)" }

{ from: "validating", to: "reviewing",
  condition: ctx => ctx.allTestsPass,
  on_fail: "All tests must pass before review" }

{ from: "reviewing", to: "committing",
  condition: ctx => ctx.mergeApproved,
  on_fail: "Merge must be approved before committing" }
```

### Reviewing State

Aligns with Container Manager's merge review mechanism:
- Auto-merge: tests pass + no sensitive files + diff < threshold -> reviewing -> committing (automatic)
- Human review triggered: CLI displays diff, waits for `/approve` or `/reject`

### Persistence

SQLite (same database as audit log, separate table). Chain integrity with same mechanism. Tamper detection scope: same as audit log (accidental corruption, not targeted attacks).

### Tech Debt Budget

```yaml
explore_mode:
  max_unverified_commits: 5
  tests_per_budget_point: 1    # write 1 passing test to recover 1 budget point
  lockout_action: block_explore
```

Budget checked at `exploring -> committing` transition. Budget exhausted -> transition denied, user must switch to strict mode or write tests. Test "passing" confirmed by Validate stage, not self-declared.

### Session Mode Switching

Via `session.set_mode` syscall. Always goes through policy check regardless of trigger source (CLI argument, environment variable, interactive command). Debug mode requires require_review. If policy denies, falls back to strict mode.

## Plugin System Module

### Lifecycle

```
DISCOVERED -> REGISTERED     (manifest valid, compatible, policy allows)
DISCOVERED -> REJECTED       (manifest invalid / incompatible / policy denied)
REGISTERED -> LOADED -> ACTIVE -> UNLOADED
                          |
                       DISABLED (by policy or runtime error)
```

REJECTED state records `rejection_reason` and `manifest_path`. Viewable via `fluffy plugin list --rejected`.

### Plugin Manifest

```yaml
name: "git-tool"
version: "1.0.0"
description: "Git operations for version control"
author: "fluffy-waffle"
runtime: "deno"
entry: "index.ts"
sandbox_template: "code-executor"
required_capabilities: ["fs.read", "fs.write", "shell.run"]
tags: ["core_plugin", "vcs"]
tools:
  - name: "git.diff"
    description: "Show changes between working tree and HEAD"
    # ... full ToolDefinition
min_kernel_version: "0.1.0"
```

### Plugin Registry

```typescript
interface PluginRegistry {
  scan(directory: string): Promise<PluginManifest[]>;
  register(manifest: PluginManifest): Promise<PluginIdentity>;
  unregister(name: string): Promise<void>;
  load(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string, reason: string): Promise<void>;
  list(filter?: PluginFilter): PluginInfo[];
  get(name: string): PluginInfo | null;
  getByTag(tag: string): PluginInfo[];
}
```

### Isolation

Each plugin runs in its own L2 sandbox. v1: no direct inter-plugin communication. Data flows between plugins through AI's tool call chain (AI calls tool A -> result returns to AI -> AI calls tool B).

### Built-in vs Third-Party Plugins

**Built-in** (shipped with system): fs-tool, search-tool, git-tool, test-tool. Tags: `["core_plugin"]`.

**Third-party** (user-installed): v1 supports local path installation only.

```
fluffy plugin install ./path/to/plugin    # v1: local only
fluffy plugin install registry:git-tool   # future: central registry
```

Third-party installation triggers require_review policy check. Default tags: `["third_party"]`. More restricted permissions than core plugins.

### Capability Pre-check

At registration, kernel pre-checks whether policy would allow the plugin's `required_capabilities`. If pre-check fails: warning (not blocking), since policy may change at runtime. Runtime syscalls still go through full policy evaluation.

### Version Compatibility

Kernel checks `min_kernel_version` against current version. Syscall interface carries a version number; kernel supports the latest 2 versions. Plugins older than 2 versions must update.

### Plugin Identity and Security

- Identity assigned at registration: `(plugin_name, container_id)` pair
- Capability tags from manifest, verified by kernel
- Plugin signing: v1 uses filesystem permissions (plugin directory owned by trusted user). Future: cryptographic signing for central registry plugins.
- Keys stored in OS keyring (macOS Keychain, Linux kernel keyring/libsecret). Fallback: filesystem with 0600 permissions.

## CLI Layer Module

### Command Structure

```
fluffy                             # interactive mode
fluffy "add error handling"        # direct task execution
fluffy --mode explore              # specify mode at startup

fluffy session list|resume <id>    # session management
fluffy plugin list|install|remove  # plugin management
fluffy config init|set|policy edit # configuration
fluffy audit log|verify            # audit operations

# Interactive mode commands
/strict /explore /debug            # mode switching
/status                            # current state info
/budget                            # tech debt budget
/approve /reject                   # merge review decisions
```

### Interactive Output Rendering

```
+-- fluffy v0.1.0 -- strict mode -- idle --------+

You: Add error handling to parseConfig

  Reading /src/utils.ts... (3ms)
  Read 85 lines

AI: I'll write tests for the error handling first.

  Writing tests/utils.test.ts... (215ms)
  Wrote 42 lines

  Running tests/utils.test.ts... (1.2s)
  1 failed (expected: parseConfig throws on invalid input)

AI: Tests ready. Now implementing the error handling.

  Writing src/utils.ts... (198ms)
  Modified 12 lines

  Running tests/utils.test.ts... (0.8s)
  1 passed

  Merging changes...
  Auto-approved: tests pass, no sensitive files, 54 lines changed

  Committing: "Add error handling to parseConfig"

Done. Added error handling to parseConfig with tests.

[strict] [idle] > _
```

Time annotations show end-to-end latency (including IPC + policy check), not just tool work time.

### Error Display Standard

All user-facing errors use a structured format:

```typescript
interface UserFacingError {
  level: "error" | "warn" | "info";
  what: string;      // what happened
  why: string;       // why it happened
  fix: string;       // how to fix it
  context?: string;  // optional: relevant state info
}
```

Example:
```
ERROR: Cannot modify source code
Reason: Workflow state is 'test_writing' - tests must be written first
Fix: Write tests for the target functionality, then source code modification will be available
```

### Session Management

Sessions persisted in SQLite (same DB as audit log and state machine). Contains: id, timestamps, state machine state, session mode, conversation history, tech debt budget. Auto-cleanup: sessions older than 30 days archived.

### Configuration Hierarchy

```
Priority (high -> low):
  1. CLI arguments (--mode explore)
  2. Environment variables (FLUFFY_MODE=explore)
  3. Project config (.fluffy/config.yaml)
  4. User config (~/.fluffy/config.yaml)
  5. System defaults
```

**Security constraint**: This hierarchy only affects non-security configuration (ai_provider, model, container_runtime, theme). Security-related settings (session_mode) always go through policy check regardless of source. policy.yaml is separate and uses the `policy.update` mechanism.

## End-to-End Scenario: "Add error handling to parseConfig"

System in strict mode. Validates all module interactions.

```
Phase 1: User Input
  1. User types: "Add error handling to parseConfig"
  2. CLI -> Kernel (session.message syscall)
  3. State Machine: idle -> planning

Phase 2: AI Reads Context
  4. ToolContextManager.getAvailableTools(state=planning) -> all tools
  5. System prompt: "Workflow state: planning. All tools available."
  6. Kernel -> AI Provider sandbox (IPC): chat with tools
  7. AI: tool_call fs.read("/src/utils.ts")
  8. Policy check (capability token for fs.read) -> ALLOW
  9. Kernel-native fast path (read-only) -> 3ms
  10. Result -> AI Provider sandbox

Phase 3: AI Generates Tests (strict mode enforced)
  11. AI calls plan.complete -> State Machine: planning -> test_writing
  12. System prompt: "Workflow state: test_writing. Writable: tests/** only."
  13. AI: tool_call fs.write("tests/utils.test.ts", testContent)
  14. Policy check -> ALLOW (tests/** writable in test_writing)
  15. Scheduler creates task -> Container Manager creates L2 sandbox (~200ms)
  16. Tool Plugin writes to output volume
  17. Result -> OutputSanitizer -> AI
  18. AI: tool_call test.run("tests/utils.test.ts")
  19. Tests fail (expected: TDD Red phase)

Phase 4: AI Generates Code
  20. State Machine: test_writing -> code_writing
      (guard: tests exist AND executed AND at least one fails)
  21. System prompt: "Workflow state: code_writing. Writable: src/** only."
  22. AI: tool_call fs.write("src/utils.ts", updatedContent)
  23. Policy check -> ALLOW, routed to L2 sandbox
  24. Tool Plugin writes to output volume

Phase 5: Validate
  25. State Machine: code_writing -> validating
  26. AI: tool_call test.run -> all tests pass
  27. State Machine: validating -> reviewing

Phase 6: Review & Merge
  28. Kernel extracts diffs from output volumes
  29. Auto-merge criteria met (tests pass, no sensitive files, diff < 500 lines)
  30. Kernel applies diffs to project directory (L1)
  31. Audit log records all diffs, test results, policy decisions

Phase 7: Commit
  32. State Machine: reviewing -> committing
  33. AI: tool_call git.commit -> git-tool plugin sandbox
  34. State Machine: committing -> idle
  35. CLI: "Done. Added error handling to parseConfig with tests."
```

**Verification points**:
- Security Policy: every tool call goes through policy check (steps 8, 14, 23, 26, 33)
- Container Manager: L2 sandbox for all write operations and test runs (steps 15-16, 23-24, 26)
- Scheduler: tasks follow dependency order, test_writing before code_writing
- State Machine: enforces TDD flow (planning -> test_writing -> code_writing -> validating -> reviewing -> committing)
- AI Tools: read operations use fast path (step 9), write operations use sandbox (steps 16, 24)
- Audit Log: full trail recorded (step 31)
- Streaming: text_delta displayed in real-time, tool status events shown during waits

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Layered kernel | Strongest security model with clear separation of concerns |
| Boundary enforcement | Container isolation + IPC | Only reliable hard boundary in pure software |
| Policy default | Default-deny | Zero-trust requires explicit authorization |
| Policy language | YAML + TypeScript | Declarative for common cases, programmable for edge cases |
| TDD enforcement | State machine guards | System-level enforcement, not prompt-level suggestion |
| Container pooling | Image pre-caching | Container pooling infeasible (no post-creation mount) |
| Network isolation | Application-layer proxy | Safer than IP-layer rules, no DNS issues |
| Context management | Conservative (all tools visible) | Avoids "AI doesn't know what it doesn't know" problem |
| Tool write path | Always through sandbox | Preserves "all writes isolated" invariant |
| Audit write | Sync for security events, async for operational | Balances integrity with performance |
| Plugin communication | No direct inter-plugin (v1) | Minimizes attack surface |
| Plugin installation | Local path only (v1) | Central registry security model too complex for v1 |
| Refactoring workflow | Use explore mode | Avoids state machine complexity for v1 |
| IPC protocol | Unix socket | SO_PEERCRED identity verification, low latency, no cert management |
| Storage | SQLite WAL | Single file, no external dependencies, concurrent read/write |

## Out of Scope for v1

- Central plugin registry (requires supply chain security model)
- Distributed/multi-machine deployment (requires gRPC, mTLS)
- Cryptographic tamper-proofing (requires TPM or remote trust anchor)
- Custom seccomp profiles (two predefined profiles cover all scenarios)
- Inter-plugin direct communication
- Dynamic priority scheduling (fixed priority + starvation prevention suffices)
- Layer 2 on-demand tool context loading (conservative strategy sufficient)
