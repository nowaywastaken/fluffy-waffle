# MVP Implementation Plan: Fluffy Waffle

> **Vision**: A vendor-agnostic AI programming CLI tool based on Zero-Trust and Containerization.
> **Principles**: First Principles. Bold Vision. Zero Compromise.
> **Date**: 2026-02-28
> **Status**: Awaiting Approval

---

## 1. MVP Definition

### What "Done" Looks Like

A developer runs `fluffy "Create a Hello World Express app"`. The system:

1. Launches L1 Kernel container (Bootstrap)
2. AI generates a failing test first (system-enforced TDD)
3. AI writes implementation code to pass the test
4. Code executes in L2 sandbox (zero host access)
5. Every action is recorded in an append-only, hash-chained audit log
6. Result is written to the project directory; user sees real-time streaming output

### What MVP Is NOT

- No plugin system (built-in tools only)
- No multi-session management (single session per invocation)
- No network proxy (sandboxes have no network by default)
- No meta-policy hot-reload
- No Podman adapter (Docker only; interface is ready for Podman later)

---

## 2. Current State Assessment

| Module | Status | LOC | Tests |
|:---|:---|:---|:---|
| Bootstrap | Done | 389/500 | 6 |
| Container Manager | Done | ~800 | 30 |
| IPC Transport | Done | ~600 | 24 |
| Security Policy | Done | ~700 | 20+ |
| AI Adapters | Stub | ~150 | 0 |
| Audit Log | Not started | - | - |
| State Machine | Not started | - | - |
| AI Tool System | Not started | - | - |
| CLI | Not started | - | - |
| Kernel Integration | Minimal | 47 | 0 |

**Completion**: ~40% of infrastructure. 0% of end-to-end flow.

---

## 3. Critical Decision Points

Decisions I've made autonomously are marked **[DECIDED]**. Items requiring your input are marked **[NEEDS DECISION]**.

### D1: TDD Enforcement Strictness in MVP [NEEDS DECISION]

The architecture mandates system-enforced TDD (AI must write failing test before implementation). In MVP, how strict?

| Option | Description | Trade-off |
|:---|:---|:---|
| **A) Strict** | State machine blocks `fs.write` to non-test files until a failing test exists | True to vision; may frustrate for config/docs/scaffolding |
| **B) Strict + Exemptions** | Same as A, but exempt file patterns: `*.json`, `*.md`, `*.yml`, `Dockerfile*` | Pragmatic; covers 90% of real workflows |
| **C) Advisory** | State machine tracks TDD state but only warns, never blocks | Fast to ship; undermines core differentiator |

**My recommendation**: B. It preserves the zero-compromise TDD vision while acknowledging that `package.json` edits don't need a failing test.

### D2: CLI Rendering [NEEDS DECISION]

| Option | Description | Trade-off |
|:---|:---|:---|
| **A) Raw Node.js** | `readline` + ANSI escape codes | Zero deps; full control; more work |
| **B) Ink (React for CLI)** | Declarative components, built-in streaming | Extra dep (~2MB); elegant; proven |

**My recommendation**: A. Zero external dependencies aligns with the project's minimalist philosophy. The MVP CLI is simple enough (streaming text + status line) that raw ANSI is sufficient. Ink can be evaluated for v2 if the UI grows complex.

### D3: AI Streaming Protocol [DECIDED]

**Selected**: Server-Sent Events (SSE) style streaming via native provider SDKs.

Each provider SDK (`openai`, `anthropic`) already supports streaming. The kernel will normalize provider-specific stream events into a unified `StreamEvent` type, then forward to the CLI over IPC. This avoids reinventing streaming and keeps provider coupling inside the adapter boundary.

### D4: Audit Log Integrity Model [DECIDED]

**Selected**: SHA-256 hash chain (each entry includes hash of previous entry).

Not using Merkle trees (overkill for single-writer append-only log). Not using HMAC (no shared secret needed; the chain is for tamper detection, not authentication). Chain verification runs at kernel startup and can be triggered on-demand.

### D5: Session Persistence Scope [DECIDED]

**Selected**: Single-session MVP. Session state lives in SQLite for the duration of one `fluffy` invocation. No resume across invocations in MVP.

Rationale: Session resume requires conversation context serialization, token budget recalculation, and sandbox state reconstruction. High complexity, low MVP value.

---

## 4. Architecture: Module Dependency Graph

```
CLI (Phase 6)
 |
 +-- Bootstrap (DONE) --> L1 Kernel Container
                            |
                            +-- Kernel Orchestrator (Phase 5)
                            |     |
                            |     +-- AI Loop (Phase 4)
                            |     |     |
                            |     |     +-- AI Adapters (Phase 4a)
                            |     |     +-- Tool System (Phase 3)
                            |     |     +-- State Machine (Phase 2)
                            |     |
                            |     +-- Audit Log (Phase 1)
                            |
                            +-- Container Manager (DONE)
                            +-- IPC Transport (DONE)
                            +-- Security Policy (DONE)
```

**Critical path**: Audit Log -> State Machine -> Tool System -> AI Loop -> Orchestrator -> CLI

---

## 5. Implementation Phases

### Phase 1: Audit Log Module

**Goal**: Tamper-evident, append-only record of every kernel action.

**Location**: `src/kernel/audit/`

**Files**:

| File | Responsibility | LOC Budget |
|:---|:---|:---|
| `types.ts` | AuditEntry, AuditSeverity, AuditCategory enums | ~60 |
| `store.ts` | SQLite WAL storage, schema init, append, query | ~200 |
| `chain.ts` | SHA-256 hash chain: compute, verify, repair | ~80 |
| `logger.ts` | Buffered async writer (flush every 500ms or 100 entries) | ~120 |
| `index.ts` | Public API re-exports | ~10 |

**Schema** (SQLite):

```sql
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT    NOT NULL,  -- ISO 8601
  category    TEXT    NOT NULL,  -- 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error'
  action      TEXT    NOT NULL,  -- e.g. 'fs.write', 'ai.chat', 'sandbox.create'
  actor       TEXT    NOT NULL,  -- container_id or 'kernel' or 'user'
  detail      TEXT    NOT NULL,  -- JSON payload
  decision    TEXT,              -- 'allow' | 'deny' | 'require_review' | NULL
  prev_hash   TEXT    NOT NULL,  -- SHA-256 of previous entry (genesis = '0'*64)
  hash        TEXT    NOT NULL   -- SHA-256(id|timestamp|category|action|actor|detail|decision|prev_hash)
);

CREATE INDEX idx_audit_category ON audit_log(category);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
```

**Key Design Decisions**:
- Buffer writes in memory, flush in batch (single transaction) for performance
- Chain verification at startup: read last N entries, verify hash linkage
- If chain is broken: log corruption warning, start new chain segment (do NOT block startup)
- No retention policy in MVP (append forever; disk warning at 100MB)

**Tests** (target: 12-15):
- Append single entry, verify hash chain
- Append batch, verify chain continuity
- Tamper detection (modify entry, verify fails)
- Buffer flush on threshold (100 entries)
- Buffer flush on timer (500ms)
- Concurrent append safety
- Startup chain verification (healthy)
- Startup chain verification (corrupted — graceful recovery)
- Query by category, by time range
- Genesis entry (first entry, prev_hash = '0'*64)

**Dependency**: `better-sqlite3` (synchronous SQLite binding for Node.js — WAL mode, zero async overhead for writes)

> **[NEEDS DECISION]**: SQLite binding choice
> - **Option A**: `better-sqlite3` — synchronous API, fastest Node.js SQLite binding, C++ addon (needs build step)
> - **Option B**: `node:sqlite` — Node.js v22.5+ built-in (experimental), zero deps, but API is less mature
> - **My recommendation**: A. `better-sqlite3` is battle-tested and the performance difference matters for high-frequency audit writes. The build step is acceptable since we already have `node-gyp` for the native peer_cred addon.

**Interface Contract** (`types.ts`):

```typescript
export type AuditCategory = 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error';

export interface AuditEntry {
  id?: number;                // auto-assigned by SQLite
  timestamp: string;          // ISO 8601
  category: AuditCategory;
  action: string;             // e.g. 'fs.write', 'ai.chat'
  actor: string;              // container_id | 'kernel' | 'user'
  detail: Record<string, unknown>;  // arbitrary JSON payload
  decision?: 'allow' | 'deny' | 'require_review' | null;
  prev_hash?: string;         // computed by chain module
  hash?: string;              // computed by chain module
}

export interface AuditQueryOptions {
  category?: AuditCategory;
  since?: string;             // ISO 8601 timestamp
  until?: string;             // ISO 8601 timestamp
  limit?: number;             // default 100
  offset?: number;            // default 0
}
```

**Interface Contract** (`store.ts`):

```typescript
export class AuditStore {
  constructor(dbPath: string);       // opens/creates SQLite DB, runs migrations
  append(entry: AuditEntry): number; // returns inserted id
  appendBatch(entries: AuditEntry[]): number[]; // single transaction
  query(opts: AuditQueryOptions): AuditEntry[];
  getLastEntry(): AuditEntry | null;
  getEntryRange(fromId: number, toId: number): AuditEntry[];
  close(): void;
}
```

**Interface Contract** (`chain.ts`):

```typescript
export function computeHash(entry: AuditEntry): string;
// SHA-256 of: `${id}|${timestamp}|${category}|${action}|${actor}|${JSON.stringify(detail)}|${decision ?? ''}|${prev_hash}`

export function verifyChain(entries: AuditEntry[]): { valid: boolean; brokenAt?: number };
// Iterates entries, checks each entry.hash === computeHash(entry) and entry.prev_hash === previous.hash

export function getGenesisHash(): string;
// Returns '0'.repeat(64)
```

**Interface Contract** (`logger.ts`):

```typescript
export class AuditLogger {
  constructor(store: AuditStore, opts?: { flushInterval?: number; flushThreshold?: number });
  // defaults: flushInterval=500ms, flushThreshold=100

  log(entry: Omit<AuditEntry, 'id' | 'timestamp' | 'prev_hash' | 'hash'>): void;
  // Adds timestamp, computes hash chain, buffers entry

  flush(): void;              // Force flush buffer to store
  verifyIntegrity(lastN?: number): { valid: boolean; brokenAt?: number };
  // Reads last N entries from store, runs verifyChain

  close(): void;              // Flush + clear timer + close store
}
```

---

### Phase 2: State Machine Module

**Goal**: System-enforced TDD workflow. The AI cannot skip steps.

**Location**: `src/kernel/state/`

**Files**:

| File | Responsibility | LOC Budget |
|:---|:---|:---|
| `types.ts` | States, Modes, Transitions, Guards | ~80 |
| `machine.ts` | State machine core, transition logic, guards | ~250 |
| `store.ts` | SQLite persistence, session state | ~100 |
| `index.ts` | Public API | ~10 |

**States** (Strict Mode — the default):

```
IDLE --> PLANNING --> TEST_WRITING --> TEST_RUNNING --> CODING --> TEST_RUNNING --> DONE
  ^                                       |                          |
  |                                       v                          v
  +----------------------------------  FAILED  <--------------------+
```

| State | Allowed Tool Calls | Transition Trigger |
|:---|:---|:---|
| `IDLE` | None (waiting for user prompt) | User submits task |
| `PLANNING` | `fs.read`, `search.*`, `fs.list` | AI signals "plan complete" |
| `TEST_WRITING` | `fs.read`, `search.*`, `fs.write` (test files only) | AI signals "tests written" |
| `TEST_RUNNING` | `test.run` | Test result received |
| `CODING` | `fs.read`, `search.*`, `fs.write` (non-test files + exempt patterns) | AI signals "code written" |
| `DONE` | None | All tests pass |
| `FAILED` | Depends on previous state | AI retries |

**Exempt file patterns** (per Decision D1-B):
- `*.json`, `*.yml`, `*.yaml`, `*.toml`
- `*.md`, `*.txt`
- `Dockerfile*`, `.dockerignore`
- `.gitignore`, `.env*`

**Modes**:
- `strict` (default): Full TDD enforcement as above
- `explore`: Read-only. AI can read/search but not write. For codebase understanding.
- `debug`: AI can read, write, and run tests freely. Activated when tests fail 3+ times consecutively.

**Guards** (transition validators):
- `canStartCoding`: At least one test file exists AND last test run has failures
- `canFinish`: All tests pass
- `canEnterDebug`: Consecutive failure count >= 3

**Tests** (target: 15-20):
- Valid transition sequences (happy path)
- Blocked transitions (write code before test)
- Exempt file bypass
- Mode switching (strict -> explore -> strict)
- Debug mode auto-activation
- State persistence and recovery
- Guard evaluation edge cases

**Interface Contract** (`types.ts`):

```typescript
export type TddState = 'idle' | 'planning' | 'test_writing' | 'test_running' | 'coding' | 'done' | 'failed';
export type SessionMode = 'strict' | 'explore' | 'debug';

export interface SessionState {
  state: TddState;
  mode: SessionMode;
  previous_state: TddState | null;   // for FAILED -> retry routing
  consecutive_failures: number;
  test_files: string[];               // tracked test file paths
  last_test_passed: boolean | null;
}

// Tool names the state machine understands
export type ToolName = 'fs.read' | 'fs.write' | 'fs.list' | 'fs.exists'
  | 'search.grep' | 'search.glob' | 'test.run' | 'shell.exec';

export interface ToolGateQuery {
  tool: ToolName;
  target_path?: string;   // for fs.write — needed to check test file vs source file vs exempt
}

export const EXEMPT_PATTERNS: string[] = [
  '*.json', '*.yml', '*.yaml', '*.toml',
  '*.md', '*.txt',
  'Dockerfile*', '.dockerignore',
  '.gitignore', '.env*',
];

export const TEST_FILE_PATTERNS: string[] = [
  '*.test.ts', '*.test.js', '*.spec.ts', '*.spec.js',
  'test/**', 'tests/**', '__tests__/**',
];
```

**Interface Contract** (`machine.ts`):

```typescript
import type { AuditLogger } from '../audit/index.ts';

export class TddStateMachine {
  constructor(audit: AuditLogger);

  getState(): SessionState;
  getMode(): SessionMode;

  // State transitions — called by orchestrator/AI loop
  submitTask(): void;                    // idle -> planning
  completePlanning(): void;              // planning -> test_writing
  completeTestWriting(): void;           // test_writing -> test_running
  reportTestResult(passed: boolean): void; // test_running -> coding (if fail) or done (if pass after coding)
  completeCoding(): void;               // coding -> test_running
  reset(): void;                         // any -> idle

  // Mode switching
  setMode(mode: SessionMode): void;

  // Gate check — called before every tool execution
  isToolAllowed(query: ToolGateQuery): { allowed: boolean; reason?: string };
  // Returns { allowed: false, reason: "Cannot write source files in TEST_WRITING state" } etc.

  // Test file tracking
  registerTestFile(path: string): void;
  isTestFile(path: string): boolean;
  isExemptFile(path: string): boolean;
}
```

**Interface Contract** (`store.ts`):

```typescript
export class StateStore {
  constructor(dbPath: string);           // same DB file as audit, separate table
  save(state: SessionState): void;
  load(): SessionState | null;
  close(): void;
}
```

**State transition table** (machine.ts must enforce):

| From | To | Guard |
|:---|:---|:---|
| `idle` | `planning` | None |
| `planning` | `test_writing` | None |
| `test_writing` | `test_running` | At least one test file registered |
| `test_running` | `coding` | `last_test_passed === false` |
| `test_running` | `done` | `last_test_passed === true` AND `previous_state === 'coding'` |
| `test_running` | `test_writing` | `last_test_passed === true` AND `previous_state === 'test_writing'` (tests pass before coding — need failing test) |
| `coding` | `test_running` | None |
| `failed` | `test_writing` | `previous_state` was `test_writing` or `test_running` |
| `failed` | `coding` | `previous_state` was `coding` |
| Any | `failed` | Error during transition |
| Any (except idle) | `idle` | `reset()` called |

**Auto-debug rule**: When `consecutive_failures >= 3`, automatically `setMode('debug')`. In debug mode, `isToolAllowed` always returns `{ allowed: true }` for all tools.

---

### Phase 3: Tool System

**Goal**: The bridge between AI intent and sandboxed execution.

**Location**: `src/kernel/tools/`

**Files**:

| File | Responsibility | LOC Budget |
|:---|:---|:---|
| `types.ts` | ToolDefinition, ToolResult, ToolContext | ~60 |
| `registry.ts` | Tool registration, lookup, schema validation | ~80 |
| `router.ts` | Route tool calls through policy -> sandbox -> audit | ~150 |
| `builtin/fs.ts` | `fs.read`, `fs.write`, `fs.list`, `fs.exists` | ~200 |
| `builtin/search.ts` | `search.grep`, `search.glob` | ~120 |
| `builtin/test.ts` | `test.run` (execute tests in L2 sandbox) | ~150 |
| `builtin/shell.ts` | `shell.exec` (restricted shell in L2 sandbox) | ~100 |
| `index.ts` | Public API | ~10 |

**Tool Call Flow**:

```
AI returns tool_call
  --> Router receives (tool_name, args)
  --> State Machine: is this tool allowed in current state?
      NO  --> return error to AI ("Cannot write files in PLANNING state")
      YES --> continue
  --> Policy Engine: evaluate(syscall_context)
      DENY --> return error to AI + audit log
      REQUIRE_REVIEW --> pause, notify user, wait for approval
      ALLOW --> continue
  --> Execution:
      Fast-path tools (fs.read, search.*): execute in kernel process directly
      Sandbox tools (fs.write, test.run, shell.exec): execute in L2 container
  --> Audit Log: record action + result
  --> Return result to AI
```

**Fast-path vs Sandbox tools**:

| Tool | Execution | Rationale |
|:---|:---|:---|
| `fs.read` | Kernel (fast-path) | Read-only, no mutation risk |
| `fs.list` | Kernel (fast-path) | Read-only |
| `fs.exists` | Kernel (fast-path) | Read-only |
| `search.grep` | Kernel (fast-path) | Read-only |
| `search.glob` | Kernel (fast-path) | Read-only |
| `fs.write` | L2 Sandbox | Mutation — must be isolated |
| `test.run` | L2 Sandbox | Arbitrary code execution |
| `shell.exec` | L2 Sandbox | Arbitrary code execution |

**Output Volume Protocol** (for sandbox tools):
1. Kernel creates temp volume, mounts project dir as read-only + output dir as read-write into L2
2. L2 writes files to output dir
3. Kernel reads output dir, computes diff against project dir
4. Kernel applies diff to project dir (inside L1)
5. Kernel destroys L2 + volume

**Tests** (target: 15-20):
- Tool registration and lookup
- State machine gate (blocked tool returns error)
- Policy gate (denied tool returns error + audit)
- Fast-path tool execution (fs.read, search.grep)
- Sandbox tool execution (fs.write via L2)
- Output volume diff and apply
- Tool call with valid capability token (fast path)
- Concurrent tool calls (parallel AI tool_calls)
- Malformed tool arguments (graceful error)

**Interface Contract** (`types.ts`):

```typescript
export interface ToolDefinition {
  name: string;                        // e.g. 'fs.read'
  description: string;                 // for AI system prompt
  parameters: Record<string, unknown>; // JSON Schema
  execution: 'fast_path' | 'sandbox';
}

export interface ToolCallRequest {
  id: string;              // from AI response tool_call.id
  name: string;            // tool name
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;              // matches request id
  name: string;
  success: boolean;
  output: string;          // text result for AI context
  error?: string;          // if success === false
}

export interface ToolContext {
  project_dir: string;     // absolute path to project root in L1
  caller_id: string;       // container_id or 'kernel'
}
```

**Interface Contract** (`registry.ts`):

```typescript
export class ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  toAIToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  // Returns tool definitions formatted for AI system prompt / function calling
}
```

**Interface Contract** (`router.ts`):

```typescript
import type { TddStateMachine } from '../state/index.ts';
import type { PolicyEngine } from '../security/index.ts';
import type { AuditLogger } from '../audit/index.ts';
import type { ContainerManager } from '../container/index.ts';

export class ToolRouter {
  constructor(deps: {
    registry: ToolRegistry;
    stateMachine: TddStateMachine;
    policy: PolicyEngine;
    audit: AuditLogger;
    containerManager: ContainerManager;
    context: ToolContext;
  });

  async execute(request: ToolCallRequest): Promise<ToolCallResult>;
  // 1. Lookup tool in registry (fail if not found)
  // 2. State machine gate check
  // 3. Policy engine evaluation
  // 4. Execute (fast_path in-process OR sandbox via ContainerManager)
  // 5. Audit log
  // 6. Return result

  async executeBatch(requests: ToolCallRequest[]): Promise<ToolCallResult[]>;
  // Parallel execution for independent tool calls
  // Fast-path tools run concurrently; sandbox tools run sequentially (one L2 at a time in MVP)
}
```

**Built-in tool signatures** (`builtin/fs.ts`):

```typescript
// fs.read: { path: string, encoding?: string } -> file content (max 50KB, truncated with marker)
// fs.write: { path: string, content: string } -> "Written: {path} ({lines} lines)"
// fs.list: { path: string, recursive?: boolean } -> newline-separated file list
// fs.exists: { path: string } -> "true" | "false"
```

**Built-in tool signatures** (`builtin/search.ts`):

```typescript
// search.grep: { pattern: string, path?: string, glob?: string } -> matching lines with file:line prefix
// search.glob: { pattern: string, cwd?: string } -> newline-separated matching paths
```

**Built-in tool signatures** (`builtin/test.ts`):

```typescript
// test.run: { pattern?: string, timeout?: number } -> test runner stdout/stderr (max 10KB)
// Executes in L2 sandbox using 'code-executor' template
// Default timeout: 30000ms
```

**Built-in tool signatures** (`builtin/shell.ts`):

```typescript
// shell.exec: { command: string, args: string[], cwd?: string, timeout?: number } -> stdout/stderr
// Executes in L2 sandbox using 'code-executor' template
// command must NOT be a shell (no 'sh', 'bash', 'zsh') — use args array
// Default timeout: 15000ms
```

---

### Phase 4: AI Loop

**Goal**: The conversation engine that drives the AI through the TDD cycle.

**Location**: `src/kernel/ai/`

**Files** (refactor existing stubs + add new):

| File | Responsibility | LOC Budget |
|:---|:---|:---|
| `types.ts` | Unified types (replaces current `adapter.ts` types) | ~80 |
| `adapter.ts` | `AIProviderAdapter` interface (keep, refine) | ~30 |
| `adapters/openai.ts` | OpenAI implementation with streaming | ~150 |
| `adapters/anthropic.ts` | Anthropic implementation with streaming | ~150 |
| `normalizer.ts` | Normalize provider responses to unified `StreamEvent` | ~100 |
| `loop.ts` | The core AI loop: prompt -> tool calls -> state transitions | ~250 |
| `context.ts` | Conversation history management, token budget | ~150 |
| `prompts.ts` | System prompts, TDD instructions, tool descriptions | ~100 |
| `factory.ts` | Provider factory (keep, minor update) | ~30 |
| `index.ts` | Public API | ~10 |

**AI Loop Flow**:

```
User prompt
  --> context.build(system_prompt + conversation_history + user_message)
  --> adapter.chatStream(messages, tools)
  --> for each stream chunk:
        if text_delta --> forward to CLI via IPC (real-time display)
        if tool_call  --> router.execute(tool_call)
                          --> result back to conversation
                          --> state machine transition
        if stop       --> check state machine
                          if DONE: return final result
                          if not DONE: continue loop (AI self-corrects)
  --> audit log: record full conversation turn
```

**System Prompt Strategy**:

The system prompt is the most critical piece. It must:
1. Explain the TDD workflow and current state
2. List available tools with JSON Schema
3. Provide project context (file tree, recent changes)
4. Be token-efficient (target: < 2000 tokens for system prompt)

```
You are an AI programming assistant operating in a secure sandbox.

CURRENT STATE: {state} (mode: {mode})
ALLOWED ACTIONS: {allowed_tools}

WORKFLOW:
1. Understand the task
2. Write failing tests FIRST
3. Run tests (they must fail)
4. Write implementation code
5. Run tests (they must pass)
6. Report completion

RULES:
- You MUST write tests before implementation code
- You can ONLY use the tools listed below
- File writes go through a secure sandbox
- All actions are audited

TOOLS:
{tool_definitions_json}

PROJECT CONTEXT:
{file_tree_summary}
```

**Conversation Context Management**:
- Sliding window: keep last 20 messages in full
- Older messages: summarize to single assistant message ("Previously: wrote test for X, implemented Y...")
- Token budget: 80% for context, 20% reserved for response
- Tool results: truncate to 2000 chars if larger (with "[truncated]" marker)

**Streaming**:
- Unified `StreamEvent` type:
  ```typescript
  type StreamEvent =
    | { type: 'text_delta'; content: string }
    | { type: 'tool_call_start'; id: string; name: string }
    | { type: 'tool_call_delta'; id: string; arguments: string }
    | { type: 'tool_call_end'; id: string }
    | { type: 'done'; usage: TokenUsage }
    | { type: 'error'; message: string };
  ```

**Tests** (target: 12-15):
- AI loop happy path (mock adapter: test -> fail -> code -> pass)
- Tool call routing through state machine
- Streaming event normalization (OpenAI format -> unified)
- Streaming event normalization (Anthropic format -> unified)
- Context window management (sliding window)
- Context truncation (large tool results)
- Token budget enforcement
- Error recovery (AI returns invalid tool call)
- Max iterations guard (prevent infinite loops, default: 50 turns)

**Interface Contract** (`types.ts`):

```typescript
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type StreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; message: string };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface AILoopResult {
  success: boolean;
  turns: number;
  files_changed: string[];
  summary: string;           // AI-generated summary of what was done
  total_usage: TokenUsage;
}
```

**Interface Contract** (`adapter.ts` — refine existing):

```typescript
export interface AIProviderAdapter {
  name: string;

  chatStream(
    messages: Message[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  ): AsyncIterable<StreamEvent>;
  // Returns an async iterable of normalized StreamEvents
  // Each adapter converts provider-specific format internally
}
```

**Interface Contract** (`loop.ts`):

```typescript
import type { ToolRouter } from '../tools/index.ts';
import type { TddStateMachine } from '../state/index.ts';
import type { AuditLogger } from '../audit/index.ts';

export interface AILoopConfig {
  max_turns: number;          // default 50
  token_budget: number;       // default 100000
  context_window_size: number; // default 20 (messages kept in full)
}

export class AILoop {
  constructor(deps: {
    adapter: AIProviderAdapter;
    router: ToolRouter;
    stateMachine: TddStateMachine;
    audit: AuditLogger;
    config?: Partial<AILoopConfig>;
  });

  async run(
    userPrompt: string,
    onEvent: (event: StreamEvent) => void,
  ): Promise<AILoopResult>;
  // Main entry point. Runs the full TDD loop until DONE or max_turns.
  // onEvent callback is called for every stream event (for CLI rendering).
  // Internally:
  //   1. Build system prompt via prompts.ts
  //   2. Add user message to context
  //   3. Loop: call adapter.chatStream -> process events -> execute tools -> update state
  //   4. After each AI turn, check state machine. If DONE, return.
  //   5. If not DONE, add tool results to context and continue.

  abort(): void;
  // Stops the current loop (sets internal flag, next iteration exits)
}
```

**Interface Contract** (`context.ts`):

```typescript
export class ConversationContext {
  constructor(config: { window_size: number; token_budget: number });

  addSystem(content: string): void;
  addUser(content: string): void;
  addAssistant(content: string, tool_calls?: Message['tool_calls']): void;
  addToolResult(tool_call_id: string, name: string, content: string): void;

  build(): Message[];
  // Returns the message array for the next API call.
  // If messages exceed window_size, older messages (except system) are summarized.
  // Tool results longer than 2000 chars are truncated.

  estimateTokens(): number;
  // Rough estimate: chars / 4. Used for budget checks.

  clear(): void;
}
```

**Interface Contract** (`prompts.ts`):

```typescript
import type { TddStateMachine } from '../state/index.ts';
import type { ToolRegistry } from '../tools/index.ts';

export function buildSystemPrompt(deps: {
  stateMachine: TddStateMachine;
  toolRegistry: ToolRegistry;
  projectDir: string;
}): string;
// Builds the system prompt string using the template shown above.
// Reads file tree from projectDir (max depth 3, max 200 entries).
// Injects current state, mode, allowed tools.
```

---

### Phase 5: Kernel Orchestrator

**Goal**: Wire everything together. The kernel `main()` becomes a real orchestrator.

**Location**: `src/kernel/`

**Files**:

| File | Responsibility | LOC Budget |
|:---|:---|:---|
| `orchestrator.ts` | Lifecycle: init all modules, handle session, shutdown | ~200 |
| `config.ts` | Kernel configuration (from env vars + config file) | ~80 |
| `index.ts` | Entry point (refactor existing) | ~30 |

**Orchestrator Responsibilities**:
1. Initialize modules in dependency order: Audit -> Policy -> State -> Container -> Tools -> AI -> IPC
2. Register IPC handlers for CLI communication
3. Run the AI loop when user submits a task
4. Graceful shutdown: flush audit log, destroy sandboxes, close IPC

**IPC Protocol** (Kernel <-> CLI):

| Message Type | Direction | Payload |
|:---|:---|:---|
| `task.submit` | CLI -> Kernel | `{ prompt: string, mode?: 'strict' \| 'explore' }` |
| `task.stream` | Kernel -> CLI | `StreamEvent` |
| `task.complete` | Kernel -> CLI | `{ summary: string, files_changed: string[] }` |
| `task.error` | Kernel -> CLI | `{ error: string, recoverable: boolean }` |
| `review.request` | Kernel -> CLI | `{ action: string, detail: string }` |
| `review.response` | CLI -> Kernel | `{ approved: boolean }` |
| `health.ping` | CLI -> Kernel | `{}` |
| `health.pong` | Kernel -> CLI | `{ uptime: number }` |

**Tests** (target: 8-10):
- Full init sequence (all modules start)
- Graceful shutdown (all modules stop, no orphans)
- IPC message routing
- Task submission -> AI loop -> completion
- Error propagation (module init failure)

**Interface Contract** (`config.ts`):

```typescript
export interface KernelConfig {
  socket_path: string;        // default '/tmp/fluffy-kernel.sock'
  db_path: string;            // default '/tmp/fluffy-kernel.db'
  project_dir: string;        // required — mounted project directory
  ai_provider: 'openai' | 'anthropic';
  ai_api_key: string;
  ai_model?: string;          // provider-specific default
  max_turns: number;          // default 50
  token_budget: number;       // default 100000
}

export function loadConfig(): KernelConfig;
// Priority: CLI args (via env vars set by bootstrap) > config file > defaults
// Required env vars: FLUFFY_PROJECT_DIR, FLUFFY_AI_PROVIDER, FLUFFY_AI_API_KEY
// Optional: FLUFFY_SOCKET_PATH, FLUFFY_DB_PATH, FLUFFY_AI_MODEL, FLUFFY_MAX_TURNS
```

**Interface Contract** (`orchestrator.ts`):

```typescript
export class KernelOrchestrator {
  constructor(config: KernelConfig);

  async start(): Promise<void>;
  // Init order: AuditStore -> AuditLogger -> PolicyEngine -> TddStateMachine
  //   -> ContainerManager -> ToolRegistry + ToolRouter -> AILoop -> IpcServer
  // Registers IPC handlers for all message types
  // Starts listening on socket

  async handleTask(prompt: string, mode: SessionMode): Promise<void>;
  // 1. stateMachine.setMode(mode)
  // 2. stateMachine.submitTask()
  // 3. aiLoop.run(prompt, event => ipc.broadcast('task.stream', event))
  // 4. On completion: ipc.broadcast('task.complete', result)
  // 5. On error: ipc.broadcast('task.error', { error, recoverable })

  async shutdown(): Promise<void>;
  // 1. aiLoop.abort() if running
  // 2. containerManager.destroyAll()
  // 3. auditLogger.close()
  // 4. ipcServer.close()
  // Order matters: stop work first, then clean resources, then close connections
}
```

**IPC Message Wire Format** (over existing length-prefixed JSON protocol):

```typescript
// All IPC messages follow this envelope:
interface IpcEnvelope {
  type: string;               // e.g. 'task.submit', 'task.stream'
  payload: Record<string, unknown>;
  request_id?: string;        // for request-response pairs (review.request/response)
}
```

---

### Phase 6: CLI Layer

**Goal**: The user-facing terminal interface.

**Location**: `src/cli/`

**Files**:

| File | Responsibility | LOC Budget |
|:---|:---|:---|
| `index.ts` | Entry point, arg parsing | ~80 |
| `commands/run.ts` | `fluffy <prompt>` — main command | ~100 |
| `commands/audit.ts` | `fluffy audit` — view audit log | ~80 |
| `commands/version.ts` | `fluffy --version` | ~10 |
| `renderer.ts` | ANSI streaming renderer (text + status + tool calls) | ~200 |
| `client.ts` | IPC client (connect to kernel, send/receive messages) | ~100 |
| `index.ts` | Command router | ~40 |

**CLI Commands**:

```bash
fluffy "Create a Hello World Express app"    # Main: submit task
fluffy --mode explore "Explain this codebase" # Explore mode (read-only)
fluffy audit                                  # View recent audit entries
fluffy audit --verify                         # Verify audit chain integrity
fluffy --version                              # Version info
fluffy --help                                 # Usage help
```

**Renderer Output Format**:

```
$ fluffy "Create a Hello World Express app"

[kernel] Starting L1 container...
[kernel] Ready.

[state: PLANNING]
I'll create a simple Express app with a Hello World endpoint.
Let me first look at the project structure.

  > fs.list(path: ".")
  package.json  src/  node_modules/

[state: TEST_WRITING]
Writing a test for the Hello World endpoint.

  > fs.write(path: "test/app.test.ts", content: "...")
  Written: test/app.test.ts (24 lines)

[state: TEST_RUNNING]
  > test.run(pattern: "test/app.test.ts")
  FAIL: 1 test failed (expected)

[state: CODING]
Now implementing the Express app.

  > fs.write(path: "src/app.ts", content: "...")
  Written: src/app.ts (18 lines)

[state: TEST_RUNNING]
  > test.run(pattern: "test/app.test.ts")
  PASS: 1 test passed

[state: DONE]
Task complete. Files changed:
  + test/app.test.ts
  + src/app.ts
```

**Tests** (target: 8-10):
- Arg parsing (all commands)
- IPC client connect/disconnect
- Renderer: streaming text output
- Renderer: tool call display
- Renderer: state transition display
- Renderer: review prompt (user approval flow)

**Interface Contract** (`client.ts`):

```typescript
export class KernelClient {
  constructor(socketPath: string);

  async connect(): Promise<void>;
  // Connects to kernel IPC socket. Throws if kernel not running.

  async submitTask(prompt: string, mode?: SessionMode): Promise<void>;
  // Sends { type: 'task.submit', payload: { prompt, mode } }

  onEvent(handler: (event: StreamEvent) => void): void;
  // Registers handler for 'task.stream' messages

  onComplete(handler: (result: { summary: string; files_changed: string[] }) => void): void;
  onError(handler: (err: { error: string; recoverable: boolean }) => void): void;

  onReviewRequest(handler: (req: { action: string; detail: string }) => Promise<boolean>): void;
  // Handler returns true (approved) or false (denied)
  // Client sends { type: 'review.response', payload: { approved } } back

  async ping(): Promise<{ uptime: number }>;
  async disconnect(): Promise<void>;
}
```

**Interface Contract** (`renderer.ts`):

```typescript
export class CliRenderer {
  constructor(output: NodeJS.WritableStream);  // typically process.stdout

  renderStreamEvent(event: StreamEvent): void;
  // text_delta -> write content directly (streaming text)
  // tool_call_start -> write "  > {name}(" in dim color
  // tool_call_end -> write ")" + newline
  // done -> write nothing (handled by onComplete)
  // error -> write in red

  renderStateChange(state: TddState): void;
  // Writes "[state: {STATE}]" in cyan, with newline

  renderToolResult(result: ToolCallResult): void;
  // Success: write indented output (max 5 lines, truncate with "...")
  // Failure: write error in red

  renderComplete(result: { summary: string; files_changed: string[] }): void;
  // Writes summary + file list

  renderReviewPrompt(action: string, detail: string): Promise<boolean>;
  // Writes prompt, reads y/n from stdin, returns boolean

  renderError(error: string): void;
  // Writes "[error] {message}" in red
}
```

**Interface Contract** (`commands/run.ts`):

```typescript
export async function runCommand(args: {
  prompt: string;
  mode: SessionMode;
  socketPath: string;
}): Promise<void>;
// 1. Create KernelClient, connect
// 2. Create CliRenderer
// 3. Wire: client.onEvent -> renderer.renderStreamEvent
// 4. Wire: client.onComplete -> renderer.renderComplete
// 5. Wire: client.onReviewRequest -> renderer.renderReviewPrompt
// 6. client.submitTask(prompt, mode)
// 7. Wait for completion or error
// 8. Disconnect
```

**Interface Contract** (`index.ts` — CLI entry point):

```typescript
// Arg parsing (no external deps — use process.argv directly):
// fluffy <prompt>                    -> runCommand({ prompt, mode: 'strict' })
// fluffy --mode explore <prompt>     -> runCommand({ prompt, mode: 'explore' })
// fluffy audit                       -> auditCommand({})
// fluffy audit --verify              -> auditCommand({ verify: true })
// fluffy --version                   -> print version from package.json
// fluffy --help                      -> print usage text

// Bootstrap integration:
// The CLI does NOT start the kernel directly.
// Bootstrap (src/bootstrap/index.ts) starts the L1 container.
// The CLI connects to the kernel via IPC socket.
// Flow: user runs `fluffy "prompt"` -> bootstrap starts kernel -> CLI connects -> submits task
```

---

## 6. Dependency Management

### New Dependencies

| Package | Purpose | Size | Phase |
|:---|:---|:---|:---|
| `better-sqlite3` | SQLite binding (audit log, state machine) | ~2MB native | Phase 1 |

**That's it.** One new dependency. Everything else uses Node.js built-ins or existing deps (`openai`, `anthropic`, `yaml`, `picomatch`).

### Existing Dependencies (already in package.json)

| Package | Used By |
|:---|:---|
| `openai` | AI adapter (OpenAI) |
| `anthropic` | AI adapter (Anthropic) |
| `yaml` | Policy YAML loader |
| `picomatch` | Glob pattern matching (policy, tools) |

---

## 7. Testing Strategy

### Test Budget Per Phase

| Phase | Module | Target Tests | Priority |
|:---|:---|:---|:---|
| 1 | Audit Log | 12-15 | P0 |
| 2 | State Machine | 15-20 | P0 |
| 3 | Tool System | 15-20 | P0 |
| 4 | AI Loop | 12-15 | P1 |
| 5 | Orchestrator | 8-10 | P1 |
| 6 | CLI | 8-10 | P1 |
| **Total** | | **70-90 new tests** | |

Combined with existing 60+ tests: **130-150 total tests at MVP**.

### Testing Approach

- **Unit tests**: Every module in isolation (mock dependencies)
- **Integration tests**: Phase 5 wires real modules together
- **No E2E in CI**: E2E requires Docker, run manually or in container-capable CI
- **Test runner**: `node:test` (built-in, no deps)
- **Incremental**: 5-10 tests per batch, verify before continuing

---

## 8. File Structure (Final MVP)

```
src/
  bootstrap/
    index.ts                    # (existing) Trust anchor
    health-check.test.ts        # (existing)
  kernel/
    index.ts                    # (refactor) Entry point
    orchestrator.ts             # (new) Module lifecycle
    config.ts                   # (new) Configuration
    container/                  # (existing) L2 sandbox management
    ipc/                        # (existing) Unix socket transport
    security/                   # (existing) Policy engine
    audit/                      # (new) Audit log
      types.ts
      store.ts
      chain.ts
      logger.ts
      index.ts
    state/                      # (new) TDD state machine
      types.ts
      machine.ts
      store.ts
      index.ts
    tools/                      # (new) Tool system
      types.ts
      registry.ts
      router.ts
      builtin/
        fs.ts
        search.ts
        test.ts
        shell.ts
      index.ts
    ai/                         # (refactor) AI adapters + loop
      types.ts
      adapter.ts
      adapters/
        openai.ts
        anthropic.ts
      normalizer.ts
      loop.ts
      context.ts
      prompts.ts
      factory.ts
      index.ts
  cli/                          # (new) CLI layer
    index.ts
    commands/
      run.ts
      audit.ts
      version.ts
    renderer.ts
    client.ts
  utils/
    execFileNoThrow.ts          # (existing)
native/                         # (existing) C++ peer_cred addon
```

---

## 9. Execution Order & Dependencies

```
Week 1:  Phase 1 (Audit Log)
         No blockers. Pure new module.

Week 2:  Phase 2 (State Machine)
         Depends on: Audit Log (logs state transitions)

Week 3:  Phase 3 (Tool System)
         Depends on: State Machine (gate checks), Policy Engine (existing), Container Manager (existing)

Week 4:  Phase 4 (AI Loop)
         Depends on: Tool System, AI Adapters (refactor existing stubs)

Week 5:  Phase 5 (Orchestrator) + Phase 6 (CLI)
         Depends on: All above. These two can be developed in parallel.

Week 6:  Integration testing, bug fixes, polish
```

**Critical path**: Audit -> State Machine -> Tools -> AI Loop -> Orchestrator

Phases 5 and 6 can run in parallel since the IPC protocol is defined upfront.

---

## 10. Risk Register

| Risk | Impact | Mitigation |
|:---|:---|:---|
| L2 sandbox creation latency > 500ms | Poor UX, slow tool calls | Pre-warm sandbox pool (create 1-2 idle sandboxes at startup) |
| AI generates invalid tool calls | Loop stalls | Max 3 retries per tool call, then skip with error message to AI |
| AI infinite loop (never reaches DONE) | Resource waste | Hard cap: 50 turns per task. After 50, force-stop and report |
| SQLite WAL corruption on crash | Audit log integrity loss | Chain verification at startup + new chain segment on corruption |
| `better-sqlite3` build fails on target | Blocks Phase 1 | Fallback: `node:sqlite` (experimental but zero build step) |
| Token budget exceeded mid-conversation | AI loses context | Aggressive summarization of old messages; warn user |
| Docker socket permission denied in L1 | L2 sandboxes can't start | Dockerfile.kernel already handles this; document required host setup |

---

## 11. Out of Scope (Deferred to v2)

- Podman adapter
- Plugin system and SDK
- Multi-session / session resume
- Network proxy for sandboxes
- Meta-policy hot-reload
- Custom seccomp profiles
- Conversation history export
- CI/CD integration
- Remote/cloud execution mode
- Windows support

---

## 12. Success Criteria

The MVP is complete when:

1. `fluffy "Create a Hello World Express app"` produces working code via TDD cycle
2. Every AI action is recorded in a verifiable audit log
3. All code execution happens in L2 sandboxes (zero host writes)
4. The state machine prevents writing code before tests
5. Real-time streaming output shows the AI's thought process
6. 130+ tests pass
7. Works on both Linux and macOS with Docker installed

---

*Status: Awaiting approval. Created: 2026-02-28.*
