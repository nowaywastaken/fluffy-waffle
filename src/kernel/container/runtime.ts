import { spawn } from 'node:child_process';
import {
  execFileNoThrow,
  type ExecOptions,
  type ExecResult,
} from '../../utils/execFileNoThrow.ts';
import { writeSeccompProfile } from './seccomp.ts';
import type {
  ContainerRuntime,
  SandboxConfig,
  ContainerId,
  ContainerState,
  RunOptions,
  RunResult,
  LogOptions,
  VolumeId,
} from './types.ts';

interface DockerAdapterDeps {
  exec?: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  seccompWriter?: (profile: SandboxConfig['seccomp_profile']) => Promise<string>;
  spawnProc?: typeof spawn;
}

export class DockerAdapter implements ContainerRuntime {
  private readonly binary: string;
  private readonly exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  private readonly seccompWriter: (profile: SandboxConfig['seccomp_profile']) => Promise<string>;
  private readonly spawnProc: typeof spawn;

  constructor(binary: string = 'docker', deps: DockerAdapterDeps = {}) {
    this.binary = binary;
    this.exec = deps.exec ?? execFileNoThrow;
    this.seccompWriter = deps.seccompWriter ?? writeSeccompProfile;
    this.spawnProc = deps.spawnProc ?? spawn;
  }

  async create(config: SandboxConfig): Promise<ContainerId> {
    const seccompPath = await this.seccompWriter(config.seccomp_profile);
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
      ...config.mounts.flatMap(m => [
        '-v', `${m.source}:${m.target}:${m.readonly ? 'ro' : 'rw'}`,
      ]),
      ...(config.env
        ? Object.entries(config.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        : []),
      config.image,
    ];
    return (await this.invoke(args)).trim();
  }

  async start(id: ContainerId): Promise<void> {
    await this.invoke(['start', id]);
  }

  async stop(id: ContainerId, timeoutMs: number): Promise<void> {
    await this.invoke(['stop', '-t', String(Math.ceil(timeoutMs / 1000)), id]);
  }

  async kill(id: ContainerId): Promise<void> {
    await this.invoke(['kill', id]);
  }

  async remove(id: ContainerId): Promise<void> {
    await this.invoke(['rm', '-f', id]);
  }

  async inspect(id: ContainerId): Promise<ContainerState> {
    const out = await this.invoke(['inspect', '--format', '{{json .State}}', id]);
    return JSON.parse(out) as ContainerState;
  }

  async createVolume(name: string): Promise<VolumeId> {
    await this.invoke(['volume', 'create', name]);
    return name;
  }

  async removeVolume(id: VolumeId): Promise<void> {
    await this.invoke(['volume', 'rm', '-f', id]);
  }

  async ping(): Promise<boolean> {
    const result = await this.exec(this.binary, ['info', '--format', '{{.ServerVersion}}']);
    return result.status === 0;
  }

  async pause(id: ContainerId): Promise<void> {
    await this.invoke(['pause', id]);
  }

  async resume(id: ContainerId): Promise<void> {
    await this.invoke(['unpause', id]);
  }

  async run(id: ContainerId, command: string[], opts: RunOptions): Promise<RunResult> {
    if (command.length === 0) {
      throw new Error('container.run requires a non-empty command');
    }
    const args = ['exec', id, ...command];
    const execOpts: ExecOptions = {};
    if (typeof opts.stdin === 'string') execOpts.stdin = opts.stdin;
    if (typeof opts.timeout === 'number') execOpts.timeoutMs = opts.timeout;
    const result = await this.exec(this.binary, args, execOpts);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
    };
  }

  async *logs(id: ContainerId, opts: LogOptions): AsyncIterable<string> {
    const args = ['logs'];
    if (typeof opts.tail === 'number') args.push('--tail', String(Math.max(0, opts.tail)));
    if (opts.follow) args.push('--follow');
    args.push(id);

    const child = this.spawnProc(this.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const queue: string[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;

    const notify = () => {
      if (!wake) return;
      const resolve = wake;
      wake = null;
      resolve();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) queue.push(line);
      }
      notify();
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message = err.code === 'ENOENT'
        ? `${this.binary} binary not found`
        : err.message;
      failure = new Error(message);
      done = true;
      notify();
    });

    child.on('close', (code) => {
      if (stdoutBuffer.length > 0) {
        queue.push(stdoutBuffer);
        stdoutBuffer = '';
      }
      if (code !== 0 && !failure) {
        const detail = stderr.trim() || `docker logs exited with code ${String(code)}`;
        failure = new Error(detail);
      }
      done = true;
      notify();
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    } finally {
      if (!done) {
        child.kill('SIGTERM');
      }
    }

    if (failure) throw failure;
  }

  private async invoke(args: string[], options: ExecOptions = {}): Promise<string> {
    const result = await this.exec(this.binary, args, options);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || `${this.binary} ${args.join(' ')} failed`;
      throw new Error(detail);
    }
    return result.stdout;
  }
}
