# Bootstrap Layer Implementation Design

## Overview

This document describes the implementation design for the Bootstrap layer of Fluffy Waffle, the trust anchor of the system. The Bootstrap layer is responsible for detecting the container runtime, starting the L1 Kernel container, performing health checks, and handling crash recovery.

**Design Approach**: Incremental enhancement + partial refactoring of existing code

**LOC Budget**: ~400 LOC (within 500 LOC limit)
- Existing code: ~100 LOC (configuration, runtime detection)
- New code: ~300 LOC (health check, crash recovery, error reporting, CLI parsing)

## Design Decisions

### Key Choices

1. **Health Check Mechanism**: Unix socket with ping/pong protocol
   - Rationale: Aligns with architecture's IPC design, secure, no port exposure
   - Socket path: `/run/fluffy/kernel.sock` (in named volume)

2. **Crash Recovery Strategy**: Exponential backoff restart
   - Backoff sequence: 1s → 2s → 4s (max)
   - Limit: 3 restarts per 5-minute sliding window
   - Rationale: Prevents rapid crash loops while allowing quick recovery from transient failures

3. **Container Security Configuration**: Docker-in-Docker (DinD) standard configuration
   - Uses `--privileged` with additional security options
   - Read-only mount of Docker socket
   - Rationale: Balanced approach for v1, follows Docker official recommendations

4. **Error Reporting**: Structured format (what/why/fix/context)
   - Rationale: User-friendly, actionable error messages

## Architecture

### Module Structure

```
Bootstrap (~400 LOC)
├── Configuration Management (~80 LOC)
│   ├── loadConfig()
│   ├── parseSimpleYaml()
│   └── Configuration priority: CLI > env > YAML > defaults
│
├── Container Runtime Detection (~40 LOC)
│   ├── detectContainerRuntime()
│   └── getInstallInstructions()
│
├── Container Startup (~120 LOC)
│   ├── startKernel()
│   ├── buildStartCommand()
│   ├── SECURITY_FLAGS (hardcoded)
│   ├── MOUNT_CONFIG (hardcoded)
│   ├── NETWORK_CONFIG (hardcoded)
│   └── RESOURCE_LIMITS (hardcoded)
│
├── Health Check (~60 LOC)
│   ├── healthCheck()
│   ├── Wait for socket file (max 30s)
│   └── Ping/pong over Unix socket
│
├── Crash Recovery (~80 LOC)
│   ├── monitorKernel()
│   ├── calculateBackoff()
│   ├── shouldRestart()
│   └── waitForContainerExit()
│
├── CLI Argument Parsing (~60 LOC)
│   ├── parseArgs()
│   ├── printHelp()
│   └── Support: --help, --version, --config, --runtime
│
└── Error Reporting (~60 LOC)
    ├── formatError()
    ├── reportNoRuntime()
    └── StructuredError interface
```

### Execution Flow

```
main()
  ↓
parseArgs() → handle --help, --version
  ↓
loadConfig() → read fluffy.yaml + env vars
  ↓
detectContainerRuntime() → docker/podman/fail
  ↓
monitorKernel() [main loop]
  ↓
  ├─→ startKernel() → spawn container
  ├─→ healthCheck() → wait for socket + ping/pong
  ├─→ waitForContainerExit() → monitor container
  ├─→ [on crash] shouldRestart() → check limits
  ├─→ [if yes] calculateBackoff() → exponential delay
  └─→ [if no] exit with error
```

## Component Details

### 1. Container Startup Configuration

**Hardcoded Security Flags** (DinD standard):

```typescript
const SECURITY_FLAGS = [
  '--privileged',                              // Required for DinD
  '--security-opt', 'apparmor=unconfined',
  '--security-opt', 'seccomp=unconfined',
  '--cap-add', 'SYS_ADMIN',                   // Container management
] as const;
```

**Mount Configuration**:

```typescript
const MOUNT_CONFIG = [
  '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',  // Read-only host socket
  '-v', '${workspaceDir}:/workspace:rw',                  // Project directory
  '-v', 'fluffy-ipc:/run/fluffy',                         // IPC socket volume
] as const;
```

**Network and Resource Limits**:

```typescript
const NETWORK_CONFIG = [
  '--network', 'bridge',
] as const;

const RESOURCE_LIMITS = [
  '--memory', '2g',
  '--cpus', '2',
] as const;
```

**Command Assembly**:

```typescript
function buildStartCommand(runtime: string, config: BootstrapConfig): string[] {
  return [
    runtime, 'run',
    '-d',                                      // Detached mode
    '--name', 'fluffy-waffle-kernel',
    '--rm',                                    // Auto-remove on exit
    ...SECURITY_FLAGS,
    ...MOUNT_CONFIG,
    ...NETWORK_CONFIG,
    ...RESOURCE_LIMITS,
    config.kernelImage,
  ];
}
```

**Key Design Points**:
- Docker socket mounted read-only (L1 only needs API access, not write)
- IPC socket uses named volume for cross-container sharing
- Resource limits prevent L1 from exhausting host resources
- `--rm` ensures cleanup on exit

### 2. Health Check Mechanism

**Configuration**:

```typescript
interface HealthCheckConfig {
  socketPath: string;              // '/run/fluffy/kernel.sock'
  timeout: number;                 // 30000ms (30s)
  retryInterval: number;           // 1000ms (1s)
}
```

**Two-Phase Check**:

1. **Phase 1: Wait for socket file**
   - Poll filesystem every 1s
   - Timeout after 30s
   - Indicates Kernel process has started

2. **Phase 2: Ping/pong protocol**
   - Connect to Unix socket
   - Send: `{"type":"ping"}\n`
   - Expect: `{"type":"pong"}\n`
   - Timeout: 5s per ping

**Implementation**:

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
      const response = JSON.parse(data.toString());
      if (response.type === 'pong') {
        client.destroy();
        resolve(true);
      } else {
        reject(new Error('Invalid response'));
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

**Error Handling**:
- Socket file not created → Kernel startup failed
- Ping timeout → Kernel process hung
- Invalid response → Protocol mismatch

### 3. Crash Recovery Mechanism

**Restart State Tracking**:

```typescript
interface RestartState {
  count: number;                   // Current restart count
  timestamps: number[];            // Restart timestamp array
  maxRestarts: number;             // Max restarts in window (3)
  windowMs: number;                // Time window (5 * 60 * 1000)
}
```

**Exponential Backoff**:

```typescript
function calculateBackoff(restartCount: number): number {
  // 1s, 2s, 4s (max)
  return Math.min(1000 * Math.pow(2, restartCount), 4000);
}
```

**Restart Decision Logic**:

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

**Main Monitor Loop**:

```typescript
async function monitorKernel(runtime: string, config: BootstrapConfig) {
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

    } catch (err) {
      console.error('Kernel startup failed:', err);
    }

    // Check restart limit
    if (!shouldRestart(state)) {
      console.error('Max restart limit reached (3 restarts in 5 minutes)');
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

**Key Features**:
- Sliding time window (only counts recent 5 minutes)
- Exponential backoff prevents rapid crash loops
- Success resets counter (allows unlimited restarts if stable)
- Exceeding limit exits with error code

### 4. Error Reporting

**Structured Error Format**:

```typescript
interface StructuredError {
  level: 'error' | 'warn' | 'info';
  what: string;      // What happened
  why: string;       // Why it happened
  fix: string;       // How to fix it
  context?: string;  // Optional context
}

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

**Example Usage**:

```typescript
function reportNoRuntime(platform: string) {
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

**Output Example**:

```
ERROR: No container runtime detected
Reason: Docker or Podman is required but not found in PATH
Fix: brew install --cask docker
Context: Platform: darwin
```

### 5. CLI Argument Parsing

**Arguments Interface**:

```typescript
interface CliArgs {
  help: boolean;
  version: boolean;
  config?: string;
  runtime?: string;
}
```

**Parser Implementation** (no framework):

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

**Help Text**:

```typescript
function printHelp() {
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

**Main Function Integration**:

```typescript
async function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.help) {
      printHelp();
      process.exit(0);
    }

    if (args.version) {
      console.log('Fluffy Waffle v0.1.0');
      process.exit(0);
    }

    console.log('--- Fluffy Waffle Bootstrap ---');

    const config = loadConfig(args.config);
    if (args.runtime) config.runtime = args.runtime;

    const runtime = detectContainerRuntime(config.runtime);
    if (!runtime) {
      reportNoRuntime(os.platform());
      process.exit(1);
    }

    console.log(`Using runtime: ${runtime}`);

    // Enter monitor loop
    await monitorKernel(runtime, config);

  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
}
```

## Implementation Strategy

### Phase 1: Refactor Existing Code
1. Keep configuration reading and runtime detection (~100 LOC)
2. Refactor `startKernel()` to use hardcoded constant arrays
3. Add proper error handling with structured errors

### Phase 2: Add Health Check
1. Implement `healthCheck()` function
2. Add Unix socket connection logic
3. Implement ping/pong protocol

### Phase 3: Add Crash Recovery
1. Implement `monitorKernel()` main loop
2. Add `calculateBackoff()` and `shouldRestart()`
3. Implement `waitForContainerExit()` helper

### Phase 4: Add CLI Parsing
1. Implement `parseArgs()` function
2. Add `printHelp()` and version handling
3. Integrate with main function

### Phase 5: Testing
1. Test runtime detection on different platforms
2. Test health check with mock Kernel
3. Test crash recovery with intentional failures
4. Test CLI argument parsing

## Testing Strategy

### Unit Tests
- Configuration parsing (YAML + env vars)
- CLI argument parsing
- Backoff calculation
- Restart limit logic

### Integration Tests
- Container startup with Docker
- Container startup with Podman
- Health check with real socket
- Crash recovery with container kill

### Manual Tests
- Test on macOS with Docker Desktop
- Test on Linux with Docker
- Test on Linux with Podman
- Test Windows WSL2 + Docker Desktop

## Success Criteria

1. **LOC Budget**: Total code ≤ 500 LOC
2. **Functionality**: All 7 modules implemented and working
3. **Reliability**: Handles crashes gracefully with exponential backoff
4. **Security**: Uses DinD standard configuration
5. **Usability**: Clear error messages with actionable fixes
6. **Cross-platform**: Works on Linux, macOS, Windows (WSL2)

## Future Enhancements (Out of Scope for v1)

- Metrics collection (restart frequency, health check latency)
- Remote logging to external service
- Container resource usage monitoring
- Automatic kernel image updates
- Multi-kernel support (multiple workspaces)

## References

- Architecture Design: `docs/plans/2026-02-26-architecture-design.md`
- Bootstrap LOC Budget: Section "Bootstrap Layer" (lines 87-114)
- IPC Transport: Section "IPC Transport Abstraction" (lines 256-284)
- Error Recovery: Section "Error Recovery" (lines 1122-1172)
