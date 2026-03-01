import { SandboxLifecycle } from './lifecycle.ts';
import { buildConfig } from './templates.ts';
import type {
  ContainerRuntime,
  SandboxConfig,
  SandboxState,
  RunOptions,
  RunResult,
  LogOptions,
} from './types.ts';

async function cleanupSandbox(
  runtime: ContainerRuntime,
  id: string,
  outputVolume: string,
): Promise<void> {
  const errors: string[] = [];
  await runtime.stop(id, 5000).catch((e: Error) => errors.push(e.message));
  await runtime.remove(id).catch((e: Error) => errors.push(e.message));
  await runtime.removeVolume(outputVolume).catch((e: Error) => errors.push(e.message));
  if (errors.length > 0) {
    console.error(`Cleanup warnings for ${id}:`, errors);
  }
}

export class ContainerManager {
  private readonly runtime: ContainerRuntime;
  private lifecycle = new SandboxLifecycle();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(runtime: ContainerRuntime) {
    this.runtime = runtime;
  }

  async createSandbox(
    template: string,
    overrides: Partial<SandboxConfig>,
  ): Promise<string> {
    const config = buildConfig(template, overrides);
    const id = config.container_id;

    this.lifecycle.transition(id, 'running');
    try {
      config.output_volume = `vol-${id}`;
      await this.runtime.createVolume(config.output_volume);
      await this.runtime.create(config);
      this.setDurationTimer(id, config.max_duration);
      return id;
    } catch (err) {
      this.lifecycle.transition(id, 'failed');
      await cleanupSandbox(this.runtime, id, `vol-${id}`).catch(() => {});
      throw err;
    }
  }

  async destroySandbox(id: string): Promise<void> {
    const current = this.lifecycle.get(id);
    if (current === 'destroyed') return;

    if (current === 'creating') {
      this.lifecycle.transition(id, 'failed');
    }
    if (this.lifecycle.get(id) === 'running') {
      this.lifecycle.transition(id, 'stopping');
    }
    if (this.lifecycle.get(id) === 'failed' || this.lifecycle.get(id) === 'stopping') {
      this.lifecycle.transition(id, 'cleanup');
    }
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    await cleanupSandbox(this.runtime, id, `vol-${id}`);
    this.lifecycle.transition(id, 'destroyed');
    this.lifecycle.delete(id);
  }

  getState(id: string): SandboxState {
    return this.lifecycle.get(id);
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.runtime.pause(id);
  }

  async resumeSandbox(id: string): Promise<void> {
    await this.runtime.resume(id);
  }

  async runInSandbox(id: string, command: string[], opts: RunOptions = {}): Promise<RunResult> {
    return this.runtime.run(id, command, opts);
  }

  async getLogs(id: string, opts: LogOptions = {}): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of this.runtime.logs(id, opts)) {
      lines.push(line);
    }
    return lines;
  }

  async shutdown(): Promise<void> {
    const ids = this.lifecycle.active();
    for (const id of ids) {
      await this.destroySandbox(id).catch((err: Error) => {
        console.error(`Failed to destroy sandbox during shutdown (${id}):`, err.message);
      });
    }
  }

  private setDurationTimer(id: string, maxDuration: number): void {
    const timer = setTimeout(async () => {
      console.warn(`Sandbox ${id} exceeded max_duration (${maxDuration}ms), terminating`);
      await this.destroySandbox(id).catch((e: Error) =>
        console.error(`Failed to terminate timed-out sandbox ${id}:`, e.message),
      );
    }, maxDuration);
    timer.unref(); // don't prevent process exit
    this.timers.set(id, timer);
  }
}
