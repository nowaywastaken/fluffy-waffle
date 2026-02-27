export type SandboxState =
  | 'creating'
  | 'running'
  | 'stopping'
  | 'cleanup'
  | 'destroyed'
  | 'failed';

export type ContainerId = string;
export type VolumeId = string;

export interface Mount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface SandboxConfig {
  plugin_name: string;
  container_id: string;
  image: string;
  mounts: Mount[];
  output_volume: string;
  network_mode: 'none' | 'restricted';
  allowed_hosts?: string[];
  memory_limit: string;
  cpu_limit: number;
  max_pids: number;
  max_duration: number;
  seccomp_profile: 'strict' | 'standard' | 'standard-net';
  env?: Record<string, string>;
}

export interface ContainerState {
  Status: string;
  Running: boolean;
  Pid: number;
  ExitCode: number;
}

export interface RunOptions {
  stdin?: string;
  timeout?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LogOptions {
  follow?: boolean;
  tail?: number;
}

export interface ContainerRuntime {
  create(config: SandboxConfig): Promise<ContainerId>;
  start(id: ContainerId): Promise<void>;
  stop(id: ContainerId, timeoutMs: number): Promise<void>;
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
