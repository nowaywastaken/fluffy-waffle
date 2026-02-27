# Bootstrap Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the Bootstrap layer with health check, crash recovery, and structured error reporting within 500 LOC budget.

**Architecture:** Incremental enhancement of existing code (~100 LOC) + new functionality (~300 LOC). Uses Unix socket for health checks, exponential backoff for crash recovery, and DinD standard security configuration.

**Tech Stack:** TypeScript, Node.js stdlib (child_process, fs, net, os), Docker/Podman

---

## Task 1: Add Type Definitions and Interfaces

**Files:**
- Modify: `src/bootstrap/index.ts:11-16`

**Step 1: Add new interfaces after BootstrapConfig**

```typescript
interface HealthCheckConfig {
  socketPath: string;
  timeout: number;
  retryInterval: number;
}

interface RestartState {
  count: number;
  timestamps: number[];
  maxRestarts: number;
  windowMs: number;
}

interface StructuredError {
  level: 'error' | 'warn' | 'info';
  what: string;
  why: string;
  fix: string;
  context?: string;
}

interface CliArgs {
  help: boolean;
  version: boolean;
  config?: string;
  runtime?: string;
}
```

**Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS (no type errors)

**Step 3: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): add type definitions for health check and error reporting"
```

---

## Task 2: Add Hardcoded Security Configuration Constants

**Files:**
- Modify: `src/bootstrap/index.ts` (after DEFAULT_CONFIG)

**Step 1: Add security configuration constants**

```typescript
const SECURITY_FLAGS = [
  '--privileged',
  '--security-opt', 'apparmor=unconfined',
  '--security-opt', 'seccomp=unconfined',
  '--cap-add', 'SYS_ADMIN',
] as const;

const MOUNT_CONFIG = (workspaceDir: string) => [
  '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
  '-v', `${workspaceDir}:/workspace:rw`,
  '-v', 'fluffy-ipc:/run/fluffy',
] as const;

const NETWORK_CONFIG = [
  '--network', 'bridge',
] as const;

const RESOURCE_LIMITS = [
  '--memory', '2g',
  '--cpus', '2',
] as const;
```

**Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): add hardcoded DinD security configuration"
```

---

## Task 3: Implement Structured Error Reporting

**Files:**
- Modify: `src/bootstrap/index.ts` (add functions before main)

**Step 1: Add formatError function**

```typescript
function formatError(error: StructuredError): string {
  const lines = [
    `${error.level.toUpperCase()}: ${error.what}`,
    `Reason: ${error.why}`,
    `Fix: ${error.fix}`,
  ];

  if (error.context) {
    lines.push(`Context: ${error.context}`);
  }

  return lines.join('\n');
}
```

**Step 2: Add reportNoRuntime function**

```typescript
function reportNoRuntime(platform: string): void {
  const error: StructuredError = {
    level: 'error',
    what: 'No container runtime detected',
    why: 'Docker or Podman is required but not found in PATH',
    fix: getInstallInstructions(platform),
    context: `Platform: ${platform}`,
  };
  console.error(formatError(error));
}
```

**Step 3: Update main() to use reportNoRuntime**

Replace lines 100-103 with:

```typescript
if (!runtime) {
  reportNoRuntime(os.platform());
  process.exit(1);
}
```

**Step 4: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 5: Test error output manually**

Run: `PATH="" node dist/bootstrap/index.js`
Expected: Structured error message with what/why/fix/context

**Step 6: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): implement structured error reporting"
```

---

## Task 4: Implement CLI Argument Parsing

**Files:**
- Modify: `src/bootstrap/index.ts` (add functions before main)

**Step 1: Add parseArgs function**

```typescript
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--config' || arg === '-c') {
      args.config = argv[++i];
    } else if (arg === '--runtime' || arg === '-r') {
      args.runtime = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}
```

**Step 2: Add printHelp function**

```typescript
function printHelp(): void {
  console.log(`
Fluffy Waffle Bootstrap v0.1.0

Usage: fluffy [options]

Options:
  -h, --help              Show this help message
  -v, --version           Show version information
  -c, --config <path>     Path to config file (default: ./fluffy.yaml)
  -r, --runtime <name>    Container runtime (docker|podman|auto)
  `);
}
```

**Step 3: Update main() to handle CLI args**

Add at the beginning of main():

```typescript
const args = parseArgs(process.argv);

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.version) {
  console.log('Fluffy Waffle v0.1.0');
  process.exit(0);
}
```

**Step 4: Update config loading to accept args**

Change `loadConfig()` signature:

```typescript
function loadConfig(configPath?: string): BootstrapConfig {
  const cfgPath = configPath || path.join(process.cwd(), 'fluffy.yaml');
  let config = { ...DEFAULT_CONFIG };

  if (fs.existsSync(cfgPath)) {
    const content = fs.readFileSync(cfgPath, 'utf8');
    const parsed = parseSimpleYaml(content);
    if (parsed['runtime']) config.runtime = parsed['runtime'];
    if (parsed['kernel_image']) config.kernelImage = parsed['kernel_image'];
    if (parsed['max_restarts']) config.maxRestarts = parseInt(parsed['max_restarts'], 10);
  }

  return config;
}
```

Update main():

```typescript
const config = loadConfig(args.config);
if (args.runtime) config.runtime = args.runtime;
```

**Step 5: Test CLI parsing**

Run: `node dist/bootstrap/index.js --help`
Expected: Help text displayed

Run: `node dist/bootstrap/index.js --version`
Expected: "Fluffy Waffle v0.1.0"

**Step 6: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): implement CLI argument parsing"
```

---

## Task 5: Refactor Container Startup

**Files:**
- Modify: `src/bootstrap/index.ts` (refactor startKernel function)

**Step 1: Add buildStartCommand helper**

```typescript
function buildStartCommand(runtime: string, config: BootstrapConfig): string[] {
  return [
    'run',
    '-d',
    '--name', 'fluffy-waffle-kernel',
    '--rm',
    ...SECURITY_FLAGS,
    ...MOUNT_CONFIG(config.workspaceDir),
    ...NETWORK_CONFIG,
    ...RESOURCE_LIMITS,
    config.kernelImage,
  ];
}
```

**Step 2: Refactor startKernel to use spawn (safer than exec)**

```typescript
async function startKernel(runtime: string, config: BootstrapConfig): Promise<void> {
  console.log(`Starting Kernel L1 container using ${runtime}...`);

  const args = buildStartCommand(runtime, config);

  return new Promise((resolve, reject) => {
    const child = spawn(runtime, args, { stdio: 'pipe' });

    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('Container started successfully');
        resolve();
      } else {
        reject(new Error(`Failed to start container (exit code ${code}): ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ${runtime}: ${err.message}`));
    });
  });
}
```

**Step 3: Import net module at top**

Add to imports:

```typescript
import * as net from 'net';
```

**Step 4: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): refactor container startup with spawn for security"
```

---

## Task 6: Implement Health Check

**Files:**
- Modify: `src/bootstrap/index.ts` (add healthCheck function)

**Step 1: Add sleep helper**

```typescript
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 2: Add healthCheck function**

```typescript
async function healthCheck(config: HealthCheckConfig): Promise<boolean> {
  const startTime = Date.now();

  // Phase 1: Wait for socket file
  while (!fs.existsSync(config.socketPath)) {
    if (Date.now() - startTime > config.timeout) {
      throw new Error('Socket file not created within timeout');
    }
    await sleep(config.retryInterval);
  }

  // Phase 2: Ping/pong
  const client = net.createConnection(config.socketPath);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('Ping timeout'));
    }, 5000);

    client.on('connect', () => {
      const ping = JSON.stringify({ type: 'ping' }) + '\n';
      client.write(ping);
    });

    client.on('data', (data) => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(data.toString());
        if (response.type === 'pong') {
          client.destroy();
          resolve(true);
        } else {
          reject(new Error('Invalid response'));
        }
      } catch (err) {
        reject(new Error('Failed to parse response'));
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

**Step 3: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): implement Unix socket health check with ping/pong"
```

---

## Task 7: Implement Crash Recovery Logic

**Files:**
- Modify: `src/bootstrap/index.ts` (add crash recovery functions)

**Step 1: Add calculateBackoff function**

```typescript
function calculateBackoff(restartCount: number): number {
  return Math.min(1000 * Math.pow(2, restartCount), 4000);
}
```

**Step 2: Add shouldRestart function**

```typescript
function shouldRestart(state: RestartState): boolean {
  const now = Date.now();
  const windowStart = now - state.windowMs;

  // Clean up timestamps outside window
  state.timestamps = state.timestamps.filter(t => t > windowStart);

  // Check if limit exceeded
  if (state.timestamps.length >= state.maxRestarts) {
    return false;
  }

  return true;
}
```

**Step 3: Add waitForContainerExit helper**

```typescript
async function waitForContainerExit(runtime: string, containerName: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(runtime, ['wait', containerName]);
    child.on('close', () => {
      resolve();
    });
  });
}
```

**Step 4: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): implement crash recovery helpers"
```

---

## Task 8: Implement Monitor Loop

**Files:**
- Modify: `src/bootstrap/index.ts` (add monitorKernel function)

**Step 1: Add monitorKernel function**

```typescript
async function monitorKernel(runtime: string, config: BootstrapConfig): Promise<void> {
  const state: RestartState = {
    count: 0,
    timestamps: [],
    maxRestarts: 3,
    windowMs: 5 * 60 * 1000,
  };

  while (true) {
    try {
      // Start container
      await startKernel(runtime, config);

      // Health check
      await healthCheck({
        socketPath: '/run/fluffy/kernel.sock',
        timeout: 30000,
        retryInterval: 1000,
      });

      console.log('Kernel started successfully');
      state.count = 0;  // Reset counter on success

      // Monitor container (blocks until exit)
      await waitForContainerExit(runtime, 'fluffy-waffle-kernel');

      console.error('Kernel container exited unexpectedly');

    } catch (err: any) {
      console.error('Kernel startup failed:', err.message);
    }

    // Check restart limit
    if (!shouldRestart(state)) {
      const error: StructuredError = {
        level: 'error',
        what: 'Kernel restart limit exceeded',
        why: 'Kernel crashed 3 times within 5 minutes',
        fix: 'Check kernel logs for errors: docker logs fluffy-waffle-kernel',
        context: `Restart attempts: ${state.timestamps.length}`,
      };
      console.error(formatError(error));
      process.exit(1);
    }

    // Exponential backoff
    const backoff = calculateBackoff(state.count);
    console.log(`Restarting in ${backoff}ms...`);
    await sleep(backoff);

    state.count++;
    state.timestamps.push(Date.now());
  }
}
```

**Step 2: Update main() to use monitorKernel**

Replace the old startKernel call with:

```typescript
// Enter monitor loop
await monitorKernel(runtime, config);
```

**Step 3: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "feat(bootstrap): implement monitor loop with exponential backoff"
```

---

## Task 9: Fix Import Issues

**Files:**
- Modify: `src/bootstrap/index.ts:1-4`

**Step 1: Ensure all required imports are present**

```typescript
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
```

**Step 2: Remove execSync import (no longer needed)**

**Step 3: Update detectContainerRuntime to use spawn**

```typescript
function detectContainerRuntime(preference: string): string | null {
  const runtimes = preference === 'auto' ? ['docker', 'podman'] : [preference];
  for (const runtime of runtimes) {
    try {
      const result = spawn(runtime, ['--version'], { stdio: 'ignore' });
      if (result) {
        return runtime;
      }
    } catch (e) {
      // Continue
    }
  }
  return null;
}
```

**Step 4: Verify TypeScript compilation**

Run: `npm run build`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "fix(bootstrap): use spawn instead of execSync for security"
```

---

## Task 10: Verify LOC Budget

**Files:**
- Check: `src/bootstrap/index.ts`

**Step 1: Count lines of code**

Run: `wc -l src/bootstrap/index.ts`
Expected: ≤ 500 LOC

**Step 2: If over budget, identify areas to optimize**

Look for:
- Redundant comments
- Unnecessary whitespace
- Functions that can be inlined

**Step 3: Document final LOC count**

Update comment at top of file:

```typescript
/**
 * Bootstrap Layer (XXX LOC / 500 LOC budget)
 * Trust Anchor of the Fluffy Waffle system.
 */
```

**Step 4: Commit**

```bash
git add src/bootstrap/index.ts
git commit -m "docs(bootstrap): document final LOC count"
```

---

## Task 11: Update TODO.md

**Files:**
- Modify: `TODO.md`

**Step 1: Mark Bootstrap tasks as complete**

Update Phase 1 section:

```markdown
### Bootstrap Layer
- [x] Implement bootstrap binary (< 500 LOC budget)
  - [x] Configuration reading (~80 LOC)
  - [x] Container runtime detection (~40 LOC)
  - [x] Container startup logic (~120 LOC)
  - [x] Health check (ping/pong) (~60 LOC)
  - [x] Crash recovery mechanism (~80 LOC)
  - [x] Entry point + CLI parsing (~60 LOC)
  - [x] Error reporting (~60 LOC)
```

**Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: mark Bootstrap layer tasks as complete"
```

---

## Task 12: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Add Bootstrap implementation to Unreleased section**

Under `### Added`:

```markdown
- Bootstrap layer implementation with health check and crash recovery
  - Unix socket health check with ping/pong protocol
  - Exponential backoff restart strategy (1s → 2s → 4s)
  - DinD security configuration with hardcoded constants
  - Structured error reporting (what/why/fix/context)
  - CLI argument parsing (--help, --version, --config, --runtime)
  - Uses spawn() instead of exec() for command injection prevention
  - LOC budget: ~XXX LOC (within 500 LOC limit)
```

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG with Bootstrap implementation"
```

---

## Testing Strategy

### Manual Testing

**Test 1: Help and Version**
```bash
node dist/bootstrap/index.js --help
node dist/bootstrap/index.js --version
```

**Test 2: Runtime Detection**
```bash
# Should detect docker/podman
node dist/bootstrap/index.js

# Should show error with install instructions
PATH="" node dist/bootstrap/index.js
```

**Test 3: Container Startup** (requires kernel image)
```bash
# This will fail until kernel image exists, but should show proper error
node dist/bootstrap/index.js
```

### Future Integration Tests

Once kernel image is available:
1. Test successful startup and health check
2. Test crash recovery by killing container
3. Test restart limit (3 crashes in 5 minutes)
4. Test exponential backoff timing

---

## Success Criteria

- ✅ All 7 modules implemented
- ✅ LOC budget ≤ 500 LOC
- ✅ TypeScript compiles without errors
- ✅ CLI arguments work (--help, --version)
- ✅ Structured error messages
- ✅ Uses spawn() for security (no exec/execSync)
- ✅ All tasks committed to git

## Next Steps

After Bootstrap is complete:
1. Implement Kernel IPC server (to respond to health checks)
2. Build kernel Docker image
3. Test end-to-end Bootstrap → Kernel startup
4. Implement Container Manager module
