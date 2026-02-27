# Container Manager Module Design

## Overview

The Container Manager module manages the lifecycle of L2 sandbox containers within the Kernel. It is responsible for creating, monitoring, and destroying sandboxes according to security policy.

**Design Approach**: Incremental refactoring of existing code + architecture alignment

**Key Decisions**:
1. Seccomp profiles: Inline TypeScript objects (version-controlled, zero external dependencies)
2. State tracking: In-memory Map + orphan scan on startup
3. Output volumes: On-demand creation in v1 (pool optimization deferred)
4. ContainerRuntime interface: Complete definition, minimal v1 implementation
5. Command execution: New `execFileNoThrow` utility (wraps execFile, prevents shell injection)

## Architecture

### File Structure

```
src/
├── utils/
│   └── execFileNoThrow.ts    (~40 LOC)  - Safe command execution utility
└── kernel/container/
    ├── types.ts              (~80 LOC)  - All interfaces and type definitions
    ├── runtime.ts            (~60 LOC)  - ContainerRuntime interface + DockerAdapter
    ├── seccomp.ts            (~120 LOC) - 3 Seccomp profiles (inline objects)
    ├── templates.ts          (~60 LOC)  - 4 sandbox templates
    ├── lifecycle.ts          (~100 LOC) - State machine + in-memory tracking
    ├── manager.ts            (~120 LOC) - Main entry point, refactored from existing
    └── orphan.ts             (~60 LOC)  - Orphan container scan on startup
```

**Total estimated LOC**: ~640 LOC across 8 files (well under 500 LOC per file limit)

### Execution Flow

```
ContainerManager.initialize()
  -> scanOrphans() [cleanup orphans from previous crash]

ContainerManager.createSandbox(template, overrides)
  -> lifecycle.transition(id, 'creating')
  -> runtime.createVolume(output_volume)
  -> writeSeccompProfile(profile) -> temp file
  -> runtime.create(config) [execFileNoThrow docker run ...]
  -> lifecycle.transition(id, 'running')
  -> setDurationTimer(id, max_duration)

ContainerManager.destroySandbox(id)
  -> lifecycle.transition(id, 'stopping')
  -> lifecycle.transition(id, 'cleanup')
  -> cleanupSandbox() [idempotent, each step independent]
      -> runtime.stop()         [ignore error]
      -> runtime.remove()       [ignore error]
      -> runtime.removeVolume() [ignore error]
  -> lifecycle.transition(id, 'destroyed')
```

## Component Details

### 0. execFileNoThrow Utility (src/utils/execFileNoThrow.ts)

Safe command execution wrapper. Uses `execFile` (not `exec`) — arguments are passed as an array directly to the OS, bypassing the shell entirely. No shell injection possible regardless of argument content.

```typescript
import { execFile } from 'child_process';
import * as process from 'process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function execFileNoThrow(
  command: string,
  args: string[],
): Promise<ExecResult> {
  // On Windows, prepend cmd.exe to handle .exe/.bat files
  const isWindows = process.platform === 'win32';
  const bin = isWindows ? 'cmd.exe' : command;
  const argv = isWindows ? ['/c', command, ...args] : args;

  return new Promise((resolve) => {
    execFile(bin, argv, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        status: error?.code ?? 0,
      });
    });
  });
}
```

Usage in DockerAdapter:

```typescript
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';

// Never throws — caller checks result.status
const result = await execFileNoThrow(this.binary, args);
if (result.status !== 0) {
  throw new Error(result.stderr.trim());
}
return result.stdout;
```

### 1. Type Definitions (types.ts)

**ContainerRuntime interface** (complete per architecture spec):

```typescript
interface ContainerRuntime {
  create(config: SandboxConfig): Promise<ContainerId>;
  start(id: ContainerId): Promise<void>;
  stop(id: ContainerId, timeoutMs: number): Promise<void>;
  kill(id: ContainerId): Promise<void>;
  remove(id: ContainerId): Promise<void>;
  inspect(id: ContainerId): Promise<ContainerState>;
  pause(id: ContainerId): Promise<void>;      // not implemented in v1
  resume(id: ContainerId): Promise<void>;     // not implemented in v1
  run(id: ContainerId, command: string[], opts: RunOptions): Promise<RunResult>; // not implemented in v1
  logs(id: ContainerId, opts: LogOptions): AsyncIterable<string>; // not implemented in v1
  createVolume(name: string): Promise<VolumeId>;
  removeVolume(id: VolumeId): Promise<void>;
  ping(): Promise<boolean>;
}
```

**Extended SandboxConfig** (adds missing fields from existing code):

```typescript
interface SandboxConfig {
  plugin_name: string;
  container_id: string;
  image: string;
  mounts: Mount[];
  output_volume: string;
  network_mode: 'none' | 'restricted';
  allowed_hosts?: string[];
  memory_limit: string;            // IEC units: "512MiB"
  cpu_limit: number;
  max_pids: number;
  max_duration: number;            // ms
  seccomp_profile: 'strict' | 'standard' | 'standard-net';
  env?: Record<string, string>;
}

type SandboxState = 'creating' | 'running' | 'stopping' | 'cleanup' | 'destroyed' | 'failed';
type ContainerId = string;
type VolumeId = string;
```

### 2. Seccomp Profiles (seccomp.ts)

All profiles use **default deny** (`SCMP_ACT_ERRNO`) — only explicitly authorized syscalls are allowed. This is the zero-trust principle applied at the kernel syscall level.

**strict** — for policy-sandbox and ai-provider:
- Basic computation: read, write, close, fstat, lseek, mmap, mprotect, munmap, brk
- Process: exit, exit_group, rt_sigaction, rt_sigprocmask, sigreturn, nanosleep, futex
- IPC only: socket(AF_UNIX=1), connect, send, recv, sendto, recvfrom, getsockopt, setsockopt
- No fork, no network, no filesystem writes

**standard** — for code-executor:
- All strict syscalls plus:
- Process: fork, clone (no CLONE_NEWUSER/CLONE_NEWNS), execve, wait4, waitpid, getpid, getppid, getuid, getgid
- Filesystem: open, openat, unlink, unlinkat, mkdir, mkdirat, rmdir, rename, renameat
- IPC: pipe, pipe2, dup, dup2
- Still prohibits: ptrace, mount, chroot, setuid, AF_INET/AF_INET6

**standard-net** — for integration-test:
- All standard syscalls plus:
- Network: socket (all families including AF_INET/AF_INET6)
- Network traffic still routed through application-layer proxy and subject to host whitelist

**Implementation**:

```typescript
export const SECCOMP_STRICT = {
  defaultAction: 'SCMP_ACT_ERRNO',
  architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64'],
  syscalls: [
    { names: ['read', 'write', 'close', 'fstat', 'lseek', 'mmap',
               'mprotect', 'munmap', 'brk', 'futex', 'nanosleep',
               'exit', 'exit_group', 'rt_sigaction', 'rt_sigprocmask', 'sigreturn'],
      action: 'SCMP_ACT_ALLOW' },
    { names: ['socket'],
      action: 'SCMP_ACT_ALLOW',
      args: [{ index: 0, value: 1, op: 'SCMP_CMP_EQ' }] },  // AF_UNIX=1 only
    { names: ['connect', 'send', 'recv', 'sendto', 'recvfrom',
               'getsockopt', 'setsockopt'],
      action: 'SCMP_ACT_ALLOW' },
  ],
};

export const SECCOMP_STANDARD = { ... };    // strict + fork/fs syscalls
export const SECCOMP_STANDARD_NET = { ... }; // standard + all socket families

export async function writeSeccompProfile(
  profile: 'strict' | 'standard' | 'standard-net',
): Promise<string> {
  const profiles = { strict: SECCOMP_STRICT, standard: SECCOMP_STANDARD, 'standard-net': SECCOMP_STANDARD_NET };
  const tmpPath = path.join(os.tmpdir(), `seccomp-${profile}.json`);
  await fs.writeFile(tmpPath, JSON.stringify(profiles[profile]));
  return tmpPath;
}
```

### 3. Sandbox Templates (templates.ts)

```typescript
export const SANDBOX_TEMPLATES: Record<string, Partial<SandboxConfig>> = {
  'ai-provider': {
    network_mode: 'restricted',
    memory_limit: '256MiB',
    cpu_limit: 0.5,
    max_pids: 10,
    max_duration: 120_000,
    seccomp_profile: 'strict',
  },
  'code-executor': {
    network_mode: 'none',
    memory_limit: '1GiB',
    cpu_limit: 1.0,
    max_pids: 100,
    max_duration: 300_000,
    seccomp_profile: 'standard',
  },
  'policy-sandbox': {
    network_mode: 'none',
    memory_limit: '128MiB',
    cpu_limit: 0.25,
    max_pids: 5,
    max_duration: 100,
    seccomp_profile: 'strict',
  },
  'integration-test': {
    network_mode: 'restricted',
    memory_limit: '1GiB',
    cpu_limit: 1.0,
    max_pids: 100,
    max_duration: 300_000,
    seccomp_profile: 'standard-net',
  },
};
```

### 4. Lifecycle State Machine (lifecycle.ts)

**Valid transitions**:

```
CREATING --[success]--> RUNNING --[normal]----> STOPPING --> CLEANUP --> DESTROYED
    |                      |
    | [failure]            | [abnormal: timeout/OOM/crash]
    v                      v
  FAILED ---------> CLEANUP --> DESTROYED
```

```typescript
const VALID_TRANSITIONS: Record<SandboxState, SandboxState[]> = {
  creating:  ['running', 'failed'],
  running:   ['stopping', 'failed'],
  stopping:  ['cleanup'],
  cleanup:   ['destroyed'],
  failed:    ['cleanup'],
  destroyed: [],
};

export class SandboxLifecycle {
  private states = new Map<string, SandboxState>();

  transition(id: string, next: SandboxState): void {
    const current = this.states.get(id) ?? 'creating';
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition: ${current} -> ${next} for ${id}`);
    }
    this.states.set(id, next);
  }

  get(id: string): SandboxState { return this.states.get(id) ?? 'destroyed'; }
  active(): string[] {
    return [...this.states.entries()]
      .filter(([, s]) => s !== 'destroyed')
      .map(([id]) => id);
  }
  delete(id: string): void { this.states.delete(id); }
}
```

### 5. DockerAdapter (runtime.ts)

Uses `execFileNoThrow` — no shell injection possible regardless of argument content.

```typescript
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';

export class DockerAdapter implements ContainerRuntime {
  constructor(private readonly binary: string) {}

  async create(config: SandboxConfig): Promise<ContainerId> {
    const seccompPath = await writeSeccompProfile(config.seccomp_profile);
    const args = [
      'run', '-d',
      '--name', config.container_id,
      '--network', config.network_mode === 'restricted' ? 'bridge' : 'none',
      '--memory', config.memory_limit,
      '--cpus', config.cpu_limit.toString(),
      '--pids-limit', config.max_pids.toString(),
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--security-opt', `seccomp=${seccompPath}`,
      '--init',
      '-v', `${config.output_volume}:/output:rw`,
      ...config.mounts.flatMap(m =>
        ['-v', `${m.source}:${m.target}:${m.readonly ? 'ro' : 'rw'}`]
      ),
      ...(config.env
        ? Object.entries(config.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        : []),
      config.image,
    ];
    return (await this.invoke(args)).trim();
  }

  async stop(id: ContainerId, timeoutMs: number): Promise<void> {
    await this.invoke(['stop', '-t', String(Math.ceil(timeoutMs / 1000)), id]);
  }
  async kill(id: ContainerId): Promise<void> { await this.invoke(['kill', id]); }
  async remove(id: ContainerId): Promise<void> { await this.invoke(['rm', '-f', id]); }
  async createVolume(name: string): Promise<VolumeId> {
    await this.invoke(['volume', 'create', name]);
    return name;
  }
  async removeVolume(id: VolumeId): Promise<void> {
    await this.invoke(['volume', 'rm', '-f', id]);
  }
  async ping(): Promise<boolean> {
    const result = await execFileNoThrow(this.binary, ['info', '--format', '{{.ServerVersion}}']);
    return result.status === 0;
  }
  async inspect(id: ContainerId): Promise<ContainerState> {
    const out = await this.invoke(['inspect', '--format', '{{json .State}}', id]);
    return JSON.parse(out);
  }

  // v1 not implemented
  pause(_id: ContainerId): Promise<void> { throw new Error('not implemented'); }
  resume(_id: ContainerId): Promise<void> { throw new Error('not implemented'); }
  run(_id: ContainerId, _cmd: string[], _opts: RunOptions): Promise<RunResult> {
    throw new Error('not implemented');
  }
  logs(_id: ContainerId, _opts: LogOptions): AsyncIterable<string> {
    throw new Error('not implemented');
  }

  private async invoke(args: string[]): Promise<string> {
    const result = await execFileNoThrow(this.binary, args);
    if (result.status !== 0) throw new Error(result.stderr.trim());
    return result.stdout;
  }
}
```

### 6. Orphan Scanner (orphan.ts)

```typescript
export async function scanOrphans(
  runtime: ContainerRuntime,
  lifecycle: SandboxLifecycle,
): Promise<void> {
  const containers = await listContainersWithPrefix(runtime, 'fw-sandbox-');
  const active = new Set(lifecycle.active());

  for (const { id, name } of containers) {
    if (!active.has(name)) {
      console.warn(`Found orphan container: ${name}, cleaning up...`);
      await cleanupSandbox(runtime, id, `vol-${name}`).catch(console.error);
    }
  }
}
```

### 7. ContainerManager (manager.ts)

```typescript
export class ContainerManager {
  private lifecycle = new SandboxLifecycle();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly runtime: ContainerRuntime) {}

  async initialize(): Promise<void> {
    await scanOrphans(this.runtime, this.lifecycle);
  }

  async createSandbox(template: string, overrides: Partial<SandboxConfig>): Promise<string> {
    const base = SANDBOX_TEMPLATES[template];
    if (!base) throw new Error(`Unknown template: ${template}`);

    const config: SandboxConfig = { ...base, ...overrides } as SandboxConfig;
    const id = config.container_id;

    this.lifecycle.transition(id, 'creating');
    try {
      config.output_volume = `vol-${id}`;
      await this.runtime.createVolume(config.output_volume);
      await this.runtime.create(config);
      this.lifecycle.transition(id, 'running');
      this.setDurationTimer(id, config.max_duration);
      return id;
    } catch (err) {
      this.lifecycle.transition(id, 'failed');
      await this.destroySandbox(id).catch(console.error);
      throw err;
    }
  }

  async destroySandbox(id: string): Promise<void> {
    this.lifecycle.transition(id, 'stopping');
    this.lifecycle.transition(id, 'cleanup');
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await cleanupSandbox(this.runtime, id, `vol-${id}`);
    this.lifecycle.transition(id, 'destroyed');
    this.lifecycle.delete(id);
  }

  private setDurationTimer(id: string, maxDuration: number): void {
    const timer = setTimeout(async () => {
      console.warn(`Sandbox ${id} exceeded max_duration (${maxDuration}ms), terminating...`);
      await this.destroySandbox(id).catch(console.error);
    }, maxDuration);
    this.timers.set(id, timer);
  }
}
```

## Idempotent Cleanup

```typescript
async function cleanupSandbox(
  runtime: ContainerRuntime,
  id: string,
  outputVolume: string,
): Promise<void> {
  const errors: Error[] = [];
  await runtime.stop(id, 5000).catch(e => errors.push(e));
  await runtime.remove(id).catch(e => errors.push(e));
  await runtime.removeVolume(outputVolume).catch(e => errors.push(e));
  if (errors.length > 0) {
    console.error(`Cleanup warnings for ${id}:`, errors.map(e => e.message));
  }
}
```

## Security Properties

| Property | Implementation |
|---|---|
| No shell injection | `execFileNoThrow(binary, args[])` — arguments never passed through shell |
| Minimal syscalls | Seccomp default-deny profiles (SCMP_ACT_ERRNO) |
| No privilege escalation | `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Read-only rootfs | `--read-only` flag |
| Resource isolation | `--memory`, `--cpus`, `--pids-limit` |
| Time-bounded execution | `max_duration` timer enforced from host |
| Network isolation | `network_mode: 'none'` or application-layer proxy |
| Orphan cleanup | Startup scan with `fw-sandbox-` prefix |

## Testing Strategy

### Unit Tests
- State machine: valid and invalid transitions
- Template loading and override merging
- Seccomp profile serialization
- execFileNoThrow: success, failure, Windows compatibility

### Integration Tests (requires Docker/Podman)
- Sandbox create -> running -> destroy lifecycle
- max_duration timeout enforcement
- Orphan scan cleanup
- DockerAdapter ping() health check

## Future Enhancements (Out of Scope v1)

- Volume pool (pre-created volumes for latency optimization)
- Podman adapter
- Sandbox pause/resume (debug mode)
- Container logs streaming
- Resource usage metrics
- allowed_hosts network proxy integration

## References

- Architecture Design: `docs/plans/2026-02-26-architecture-design.md`
- Container Manager: lines 388-534
- Seccomp profiles: lines 432-436
- Sandbox templates: lines 440-448
- ContainerRuntime interface: lines 464-480
