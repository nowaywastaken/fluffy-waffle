import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerManager } from './manager_new.ts';
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
});
