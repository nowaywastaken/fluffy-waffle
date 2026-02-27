import { execFileNoThrow } from '../../utils/execFileNoThrow.ts';
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
    const result = await execFileNoThrow(this.binary, ['info', '--format', '{{.ServerVersion}}']);
    return result.status === 0;
  }

  // v1: not implemented
  pause(_id: ContainerId): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }
  resume(_id: ContainerId): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }
  run(_id: ContainerId, _cmd: string[], _opts: RunOptions): Promise<RunResult> {
    return Promise.reject(new Error('not implemented'));
  }
  async *logs(_id: ContainerId, _opts: LogOptions): AsyncIterable<string> {
    throw new Error('not implemented');
  }

  private async invoke(args: string[]): Promise<string> {
    const result = await execFileNoThrow(this.binary, args);
    if (result.status !== 0) throw new Error(result.stderr.trim());
    return result.stdout;
  }
}
