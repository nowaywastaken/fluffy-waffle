import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerManager } from './manager.ts';
import type { ContainerRuntime, SandboxConfig, ContainerState } from './types.ts';

function makeMockRuntime(): ContainerRuntime {
  return {
    create: mock.fn(async (config: SandboxConfig) => config.container_id),
    start: mock.fn(async () => {}),
    stop: mock.fn(async () => {}),
    kill: mock.fn(async () => {}),
    remove: mock.fn(async () => {}),
    inspect: mock.fn(async (): Promise<ContainerState> => ({
      Status: 'running', Running: true, Pid: 100, ExitCode: 0,
    })),
    pause: mock.fn(async () => {}),
    resume: mock.fn(async () => {}),
    run: mock.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    logs: mock.fn(async function* () {}),
    createVolume: mock.fn(async (name: string) => name),
    removeVolume: mock.fn(async () => {}),
    ping: mock.fn(async () => true),
  };
}

describe('ContainerManager', () => {
  it('createSandbox creates volume and container', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);

    const id = await manager.createSandbox('code-executor', {
      plugin_name: 'test',
      container_id: 'fw-sandbox-test1',
      image: 'test-image:latest',
      mounts: [],
    });

    assert.equal(id, 'fw-sandbox-test1');
    assert.equal((runtime.createVolume as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((runtime.create as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it('createSandbox throws on unknown template', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);

    await assert.rejects(
      () => manager.createSandbox('no-such-template', { container_id: 'fw-sandbox-x' } as any),
      /Unknown template/,
    );
  });

  it('destroySandbox stops and removes container and volume', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);

    await manager.createSandbox('code-executor', {
      plugin_name: 'test',
      container_id: 'fw-sandbox-test2',
      image: 'test-image:latest',
      mounts: [],
    });

    await manager.destroySandbox('fw-sandbox-test2');

    assert.equal((runtime.stop as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((runtime.removeVolume as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it('getState returns running after createSandbox', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);

    await manager.createSandbox('policy-sandbox', {
      plugin_name: 'policy',
      container_id: 'fw-sandbox-test3',
      image: 'policy-image:latest',
      mounts: [],
    });

    assert.equal(manager.getState('fw-sandbox-test3'), 'running');
  });

  it('pauseSandbox and resumeSandbox delegate to runtime', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);
    await manager.pauseSandbox('fw-sandbox-x');
    await manager.resumeSandbox('fw-sandbox-x');
    assert.equal((runtime.pause as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((runtime.resume as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it('runInSandbox delegates command and options to runtime', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);
    const result = await manager.runInSandbox('fw-sandbox-y', ['echo', 'hi'], { timeout: 500 });
    assert.equal(result.exitCode, 0);
    const runCalls = (runtime.run as ReturnType<typeof mock.fn>).mock.calls;
    assert.equal(runCalls.length, 1);
    assert.deepEqual(runCalls[0]?.arguments[1], ['echo', 'hi']);
    assert.deepEqual(runCalls[0]?.arguments[2], { timeout: 500 });
  });

  it('getLogs collects async log stream into string array', async () => {
    const runtime = makeMockRuntime();
    runtime.logs = mock.fn(async function* () {
      yield 'line-1';
      yield 'line-2';
    });
    const manager = new ContainerManager(runtime);
    const lines = await manager.getLogs('fw-sandbox-z', { tail: 2 });
    assert.deepEqual(lines, ['line-1', 'line-2']);
  });

  it('shutdown best-effort destroys all active sandboxes', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);

    await manager.createSandbox('code-executor', {
      plugin_name: 'test',
      container_id: 'fw-sandbox-a',
      image: 'test-image:latest',
      mounts: [],
    });
    await manager.createSandbox('policy-sandbox', {
      plugin_name: 'test',
      container_id: 'fw-sandbox-b',
      image: 'test-image:latest',
      mounts: [],
    });

    await manager.shutdown();

    assert.equal(manager.getState('fw-sandbox-a'), 'destroyed');
    assert.equal(manager.getState('fw-sandbox-b'), 'destroyed');
  });

  it('handles timeout-triggered destroy racing with manual destroy', async () => {
    const runtime = makeMockRuntime();
    const manager = new ContainerManager(runtime);

    const id = await manager.createSandbox('policy-sandbox', {
      plugin_name: 'test',
      container_id: 'fw-sandbox-race',
      image: 'test-image:latest',
      mounts: [],
      max_duration: 5,
    });

    await Promise.all([
      manager.destroySandbox(id),
      new Promise<void>((resolve) => setTimeout(resolve, 20)),
    ]);

    assert.equal(manager.getState(id), 'destroyed');
  });
});
