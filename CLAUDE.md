# Fluffy Waffle - Development Guide

## Target Platforms

Linux, macOS. **Windows is not a target platform.**

- No Named Pipe implementation
- No cmd.exe shims
- No WSL2 workarounds
- Unix socket only for IPC

## Key Constraints

- Bootstrap LOC budget: strictly < 500 LOC
- Per-file LOC budget: 300 max (hard limit)
- All commands must use argument arrays via spawn() or execFileNoThrow() — never string templates
- Test runner: Node.js built-in (node:test), no extra test dependencies
- Container runtime is a hard dependency — no fallback mode
- No default exports — named exports only
- No enums — use union types or const objects
- No TypeScript parameter properties — use explicit property declarations

## Project Structure

```
src/
  bootstrap/        - Trust anchor, starts L1 Kernel container
  kernel/
    container/      - L2 sandbox lifecycle management
    ipc/            - Unix socket transport
    security/       - Policy engine
    audit/          - Append-only hash-chained audit log (SQLite)
    state/          - TDD state machine
    tools/          - Tool registry, router, built-in tools
    ai/             - AI provider adapters, conversation loop
  cli/              - CLI entry point, renderer, IPC client
  utils/            - Shared utilities (execFileNoThrow, etc.)
docs/plans/         - Architecture and implementation plans
```

## Commands

```bash
npm run build              # TypeScript compile
npm test                   # Run all tests
npm run test:container     # Run container module tests only
npm run build:native       # Build native peer_cred addon
```

## Coding Conventions

### Imports

```typescript
// Node.js built-ins: always use node: prefix
import * as fs from 'node:fs';
import crypto from 'node:crypto';

// Local modules: always use .ts extension (NOT .js)
import { SandboxLifecycle } from './lifecycle.ts';

// Type-only imports: use import type
import type { ContainerRuntime, SandboxConfig } from './types.ts';

// Third-party: standard imports
import picomatch from 'picomatch';
```

### Types

```typescript
// Interfaces for object shapes (public APIs)
export interface SandboxConfig {
  plugin_name: string;    // snake_case for data/config fields
  container_id: string;
}

// Union types for enumerations (NOT enums)
export type SandboxState = 'creating' | 'running' | 'stopped';

// Const objects for lookup tables
const VALID_TRANSITIONS: Record<SandboxState, SandboxState[]> = { ... };
```

### Property Naming

- Data/config objects: `snake_case` (e.g. `container_id`, `memory_limit`)
- Code-level interfaces: `camelCase` (e.g. `containerId`, `pluginName`)
- Classes: `PascalCase`
- Files: `kebab-case` or single-word lowercase

### Classes

```typescript
// NO parameter properties (not supported by --experimental-strip-types)
class ContainerManager {
  private readonly runtime: ContainerRuntime;
  constructor(runtime: ContainerRuntime) {
    this.runtime = runtime;
  }
}
```

### Error Handling

```typescript
// Standard Error with descriptive messages (no custom error classes)
throw new Error(`Invalid transition: ${current} -> ${next}`);

// Type-safe catch
catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
}

// Error accumulation for cleanup (don't throw on partial failure)
const errors: string[] = [];
await step1().catch((e: Error) => errors.push(e.message));
await step2().catch((e: Error) => errors.push(e.message));
```

### Tests

```typescript
// Always use node:test + node:assert/strict
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Structure: describe blocks with it tests
describe('ModuleName', () => {
  it('descriptive lowercase name', () => {
    assert.equal(actual, expected);
    assert.throws(() => badCall(), /expected pattern/);
  });
});

// Mocks: factory functions returning interface-compatible objects
function makeMockRuntime(): ContainerRuntime {
  return {
    create: mock.fn(async (config: SandboxConfig) => config.container_id),
    start: mock.fn(async () => {}),
  };
}

// Timer cleanup: always unref() to prevent test runner hanging
const timer = setTimeout(() => {}, 3000);
timer.unref();
```

### Module Structure

Each module directory follows this pattern:
```
module/
  types.ts      - Interfaces, type aliases, constants
  [impl].ts     - Implementation files (one concern per file)
  index.ts      - Barrel re-exports (named exports + type exports)
  *.test.ts     - Tests colocated with source
```

```typescript
// index.ts barrel export pattern
export { ContainerManager } from './manager.ts';
export { DockerAdapter } from './runtime.ts';
export type { SandboxConfig, ContainerRuntime } from './types.ts';
```

## References

- MVP Implementation Plan: docs/plans/2026-02-28-mvp-implementation-plan.md
- Architecture: docs/plans/2026-02-26-architecture-design.md
- Bootstrap design: docs/plans/2026-02-27-bootstrap-implementation-design.md
- Container Manager design: docs/plans/2026-02-27-container-manager-design.md
