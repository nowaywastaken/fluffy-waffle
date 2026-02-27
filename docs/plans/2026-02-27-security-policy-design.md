# Security Policy Module Design

## Overview

The Security Policy Module provides the zero-trust authorization layer for all syscall operations in the Kernel. It evaluates every operation against a layered rule set and either allows, denies, or requires human review.

**Design Approach**: Incremental refactor of existing `policy.ts` + new files for token system, YAML loader, and Deno extension sandbox.

**Key Decisions**:
1. Capability tokens: HMAC-SHA256 signed, bound to `(container_id, peer_pid)`, monotonic nonce for replay prevention
2. Deno extension sandbox: Unix socket IPC (matches existing IPC infrastructure), 100ms timeout → pass, crash → deny
3. YAML parser: `yaml` package (TypeScript-friendly)
4. Policy evaluation: order-independent semantics — only `deny` is terminal, `require_review` is collected not short-circuited
5. Glob patterns: pre-compiled at rule load time (not per evaluation)

## Architecture

### File Structure

```
src/kernel/security/
├── types.ts         (~60 LOC)  - all interfaces and type definitions (new)
├── engine.ts        (~120 LOC) - PolicyEngine refactored (renamed from policy.ts)
├── token.ts         (~100 LOC) - CapabilityToken issuance and validation
├── yaml-loader.ts   (~60 LOC)  - YAML file parsing + index construction
└── extension.ts     (~120 LOC) - Deno extension sandbox (Unix socket IPC)
```

### Evaluation Flow

```
evaluate(ctx):
  Phase 0: Built-in rules (always execute, max 10)
    - deny    → return DENY (terminal)
    - require_review → collect (not terminal)
    - allow   → collect

  Phase 1: Token fast path
    - valid token → skip Phase 2 + 3
    - invalid/absent → continue

  Phase 2: YAML rules (O(1) hash lookup by syscall type)
    - deny    → return DENY (terminal)
    - require_review → collect
    - allow   → collect

  Phase 3: Extension rules (Deno sandbox, 100ms timeout)
    - deny    → return DENY (terminal)
    - require_review → collect
    - allow   → collect
    - timeout → pass (non-blocking)
    - crash   → deny (fail-closed)

  Final: if any require_review → REQUIRE_REVIEW
         elif any allow → ALLOW
         else → DENY (default-deny)
```

## Component Details

### 1. Type Definitions (types.ts)

```typescript
export interface SyscallContext {
  type: string;
  args: Record<string, unknown>;
  caller: {
    containerId: string;
    pluginName: string;
    capabilityTags: string[];
    peer: PeerIdentity;
  };
  token?: CapabilityTokenClaim;
}

export interface PolicyRule {
  name: string;
  match: MatchCondition;
  action: 'allow' | 'deny' | 'require_review';
  except?: MatchCondition[];
  reason?: string;
  constraints?: Record<string, unknown>;
}

export interface MatchCondition {
  syscall?: string | string[];
  caller_tag?: string | string[];
  path_glob?: string | string[];
  [key: string]: unknown;
}

// Pre-compiled version used internally
export interface CompiledRule extends PolicyRule {
  _pathMatcher?: (path: string) => boolean;  // pre-compiled at load time
}

export type PolicyDecision = 'allow' | 'deny' | 'require_review' | 'pass';

export interface CapabilityTokenClaim {
  tokenId: string;
  containerId: string;
  peerPid: number;
  syscall: string;
  pathGlob?: string[];
  maxOps: number;
  expiresAt: number;       // Unix timestamp ms
  nonce: number;           // monotonically increasing
  signature: string;       // HMAC-SHA256(payload, kernelSecret)
}
```

### 2. Policy Engine Fixes (engine.ts)

**Three semantic corrections from existing policy.ts:**

**Fix 1: built-in layer must not short-circuit require_review**
```typescript
// WRONG (existing): return 'require_review'
// CORRECT: collect and continue
let builtinReview = false;
for (const rule of this.builtinRules) {
  if (this.matchRule(rule, ctx)) {
    if (rule.action === 'deny') return 'deny';         // only deny is terminal
    if (rule.action === 'require_review') builtinReview = true;
  }
}
```

**Fix 2: path_glob with no path arg → no match**
```typescript
if (condition.path_glob) {
  if (typeof ctx.args['path'] !== 'string') return false;  // added
  if (!rule._pathMatcher!(ctx.args['path'])) return false;
}
```

**Fix 3: glob pre-compiled at rule load time**
```typescript
function compileRule(rule: PolicyRule): CompiledRule {
  const compiled: CompiledRule = { ...rule };
  if (rule.match.path_glob) {
    const globs = Array.isArray(rule.match.path_glob) ? rule.match.path_glob : [rule.match.path_glob];
    compiled._pathMatcher = picomatch(globs);
  }
  return compiled;
}
```

**Five built-in rules (complete set):**

| # | Name | Protects | Action |
|---|---|---|---|
| 1 | `protect-meta-policy` | `.fluffy/policy.yaml` (fs.write) | deny |
| 2 | `protect-bootstrap` | `src/bootstrap/**` (fs.write) | require_review |
| 3 | `protect-kernel` | `src/kernel/**` (fs.write) | require_review |
| 4 | `protect-audit-log` | `.fluffy/audit.db` (fs.write) | deny |
| 5 | `protect-state-db` | `.fluffy/state.db` (fs.write) | deny |

**Engine interface:**
```typescript
export class PolicyEngine {
  constructor(
    private readonly tokenIssuer: TokenIssuer,
    private readonly extension?: ExtensionSandbox,
  ) {}

  loadYamlRules(filePath: string): void
  evaluate(ctx: SyscallContext): Promise<PolicyDecision>
}
```

`evaluate` is now `async` to support the Deno extension call.

### 3. Capability Token System (token.ts)

```typescript
export interface IssueParams {
  containerId: string;
  peerPid: number;
  syscall: string;
  pathGlob?: string[];
  maxOps?: number;      // default 1
  ttlMs?: number;       // default 30_000
}

export class TokenIssuer {
  private readonly secret: Buffer;  // random 32 bytes at startup, never logged
  private store = new Map<string, { ops: number; revoked: boolean }>();

  constructor() {
    this.secret = crypto.randomBytes(32);
  }

  issue(params: IssueParams): CapabilityTokenClaim
  validate(claim: CapabilityTokenClaim, ctx: SyscallContext, now: number): boolean
  revoke(tokenId: string): void
}
```

**Validation steps (O(1)):**
1. HMAC-SHA256 signature check — prevents forgery
2. `expiresAt > now` — `now` is snapshot at evaluate start (prevents TOCTOU, test case 22)
3. `store.get(tokenId).ops < claim.maxOps` — prevents over-use (test case 21)
4. `claim.containerId === ctx.caller.containerId` — container ID binding (test case 23)
5. `claim.peerPid === ctx.caller.peer.pid` — PID binding
6. `claim.syscall === ctx.type` — syscall type match
7. pathGlob match if present

Invalid token → return `false` → fall through to full YAML evaluation (test cases 9, 21, 22, 23).

**HMAC payload**: `JSON.stringify` of all non-signature fields, deterministic key order.

### 4. YAML Loader (yaml-loader.ts)

```typescript
export function loadYamlRules(filePath: string): Map<string, CompiledRule[]>
```

- Uses `yaml` package for parsing
- Validates required fields (`name`, `match`, `action`) — throws at kernel startup on schema error (no silent degradation)
- Pre-compiles glob patterns via `compileRule()`
- Builds index: `HashMap<syscall_type, CompiledRule[]>` for O(1) lookup
- If `match.syscall` is absent, indexes under `'*'` (matches all syscall types)

Unit specifications in `constraints` (e.g., `max_file_size: "100KiB"`) are stored as raw strings; lazy-parsed when the constraint is evaluated.

### 5. Deno Extension Sandbox (extension.ts)

**Communication**: Kernel spawns Deno as a child process. Deno connects back to a Unix socket that Kernel opens specifically for extension communication. Same IPC frame format (4-byte length prefix + UTF-8 JSON) as the main IPC layer.

```typescript
export class ExtensionSandbox {
  private process?: ChildProcess;
  private server?: IpcServer;   // dedicated socket for Deno
  private ready = false;

  async start(scriptPath: string, socketPath: string): Promise<void>
  async evaluate(ctx: SyscallContext): Promise<PolicyDecision>
  async stop(): Promise<void>

  private async warmup(): Promise<void>  // empty evaluate to eliminate JIT cold-start
}
```

**Lifecycle:**
1. Kernel creates Unix socket at `socketPath`
2. Kernel spawns: `deno run --allow-read=<scriptPath> --allow-net= <scriptPath> <socketPath>`
3. Deno script connects to `socketPath`, calls back on `ext.evaluate` method
4. Kernel sends warmup evaluate before marking `ready = true`

**Timeout handling:**
```typescript
async evaluate(ctx: SyscallContext): Promise<PolicyDecision> {
  if (!this.ready) return 'pass';
  const result = await Promise.race([
    this.sendEvaluate(ctx),
    sleep(100).then(() => 'pass' as PolicyDecision),
  ]);
  return result;
}
```

**Crash handling:**
- Deno process `exit` event → `ready = false`, return `'deny'` for in-flight calls
- Kernel attempts one restart; if second crash within 30s → stays disabled, logs FATAL

## Security Properties

| Property | Implementation |
|---|---|
| Default deny | No matching allow rule → deny |
| Deny is terminal | `return 'deny'` immediately, no further evaluation |
| Order-independent | `require_review` collected, not short-circuited |
| Token unforgeable | HMAC-SHA256 with kernel-private secret |
| Token container-bound | containerId + peerPid in signed payload |
| Replay prevention | monotonic nonce + maxOps counter |
| Extension fail-closed | crash → deny; timeout → pass (configurable) |
| Glob injection safe | picomatch with pre-compiled patterns |
| Schema errors block startup | YAML parse errors throw, not warned |

## Testing Strategy

26 normative test cases split across 3 files (each < 300 lines):

### engine.test.ts (17 cases)

**Basic semantics (1-6):**
1. No rules → deny
2. Only pass rules → deny
3. allow + deny (same syscall) → deny
4. allow + require_review → require_review
5. Extension deny + built-in allow → deny (allow does not short-circuit)
6. require_review with matching except → pass

**Aggregation (10-12, 16-17):**
10. Multiple require_review rules → require_review (reasons aggregated)
11. YAML deny short-circuits → Extension never called
12. Partial match (syscall matches, path_glob does not) → rule not applied
16. Multiple allow rules, no deny/review → allow
17. Cross-layer allow (YAML + Extension) → allow

**Defensive boundaries (18-20, 24-25):**
18. Built-in rules list empty → system still evaluates correctly
19. YAML rules file empty → default deny (built-in still active)
20. Extension sandbox crashes → deny
24. Unknown syscall type (no rules) → deny
25. path_glob is empty array → matches no paths (rule never applies)

### token.test.ts (6 cases)

7. Valid token + built-in deny → deny (token does not bypass built-in)
8. Valid token + no built-in issues → allow (token bypasses YAML/Extension)
9. Expired token → fall through to full evaluation
21. Token maxOps exhausted → invalid, fall through
22. Token TTL boundary → time snapshot at evaluate start, not at validation call
23. Token container_id mismatch → invalid

### schema-warnings.test.ts (3 cases)

26. match and except conditions identical → schema warning logged
Plus: YAML schema error throws at load time
Plus: unknown action field in YAML → schema error at load time

## Future Enhancements (Out of Scope v1)

- Meta-policy update mechanism (`policy.update` syscall with trial run)
- Extension sandbox hot reload without kernel restart
- Token revocation broadcast across multiple kernel instances
- Audit log integration (Phase 2b)

## References

- Architecture Design: `docs/plans/2026-02-26-architecture-design.md`
  - Security Policy Module: lines 150-387
  - Policy Engine Test Specifications: lines 343-387
