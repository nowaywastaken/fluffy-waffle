import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DockerAdapter } from './runtime.ts';
import type { SandboxConfig } from './types.ts';
import type { ExecOptions, ExecResult } from '../../utils/execFileNoThrow.ts';

type ExecCall = {
  command: string;
  args: string[];
  options?: ExecOptions;
};

function baseConfig(): SandboxConfig {
  return {
    plugin_name: 'plugin-x',
    container_id: 'fw-sandbox-test',
    image: 'node:22',
    mounts: [],
    output_volume: 'vol-fw-sandbox-test',
    network_mode: 'none',
    memory_limit: '256MiB',
    cpu_limit: 1,
    max_pids: 32,
    max_duration: 30_000,
    seccomp_profile: 'strict',
  };
}

function makeExec(
  responses: ExecResult[],
  calls: ExecCall[],
): (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult> {
  return async (command: string, args: string[], options?: ExecOptions) => {
    calls.push({ command, args, options });
    const next = responses.shift();
    return next ?? { stdout: '', stderr: '', status: 0 };
  };
}

function makeFakeSpawnWithLogs(lines: string[]): typeof import('node:child_process').spawn {
  return ((_: string, __: string[]) => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    emitter.kill = () => {};

    setImmediate(() => {
      emitter.stdout.write(lines.join('\n'));
      emitter.stdout.end();
      emitter.emit('close', 0);
    });

    return emitter as any;
  }) as typeof import('node:child_process').spawn;
}

describe('DockerAdapter', () => {
  it('create builds hardened docker run args and trims returned id', async () => {
    const calls: ExecCall[] = [];
    const adapter = new DockerAdapter('docker', {
      exec: makeExec([{ stdout: 'abc123\n', stderr: '', status: 0 }], calls),
      seccompWriter: async () => '/tmp/seccomp-test.json',
    });

    const id = await adapter.create(baseConfig());
    assert.equal(id, 'abc123');
    assert.equal(calls.length, 1);
    const runArgs = calls[0]?.args ?? [];
    assert.ok(runArgs.includes('--read-only'));
    assert.ok(runArgs.includes('--cap-drop'));
    assert.ok(runArgs.includes('ALL'));
    assert.ok(runArgs.includes('--security-opt'));
    assert.ok(runArgs.includes('seccomp=/tmp/seccomp-test.json'));
  });

  it('pause and resume delegate to docker pause/unpause', async () => {
    const calls: ExecCall[] = [];
    const adapter = new DockerAdapter('docker', {
      exec: makeExec([
        { stdout: '', stderr: '', status: 0 },
        { stdout: '', stderr: '', status: 0 },
      ], calls),
    });

    await adapter.pause('sandbox-1');
    await adapter.resume('sandbox-1');

    assert.deepEqual(calls[0]?.args, ['pause', 'sandbox-1']);
    assert.deepEqual(calls[1]?.args, ['unpause', 'sandbox-1']);
  });

  it('run returns stdout/stderr/exitCode and forwards timeout/stdin', async () => {
    const calls: ExecCall[] = [];
    const adapter = new DockerAdapter('docker', {
      exec: makeExec([{ stdout: 'ok\n', stderr: 'warn\n', status: 7 }], calls),
    });

    const result = await adapter.run('sandbox-2', ['sh', '-lc', 'echo ok'], {
      stdin: 'input-data',
      timeout: 1200,
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(result.stderr, 'warn\n');
    assert.deepEqual(calls[0]?.args, ['exec', 'sandbox-2', 'sh', '-lc', 'echo ok']);
    assert.deepEqual(calls[0]?.options, { stdin: 'input-data', timeoutMs: 1200 });
  });

  it('logs yields newline-delimited output', async () => {
    const adapter = new DockerAdapter('docker', {
      spawnProc: makeFakeSpawnWithLogs(['line-1', 'line-2']),
    });

    const lines: string[] = [];
    for await (const line of adapter.logs('sandbox-3', { tail: 2 })) {
      lines.push(line);
    }

    assert.deepEqual(lines, ['line-1', 'line-2']);
  });
});
