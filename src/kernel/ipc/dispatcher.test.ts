// src/kernel/ipc/dispatcher.test.ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from './dispatcher.ts';
import { ContainerManager } from '../container/manager.ts';
import type { ContainerRuntime, ContainerState, SandboxConfig } from '../container/types.ts';
import { PolicyEngine } from '../security/engine.ts';
import { TokenIssuer } from '../security/token.ts';
import { TddStateMachine } from '../state/machine.ts';
import { AuditLogger } from '../audit/logger.ts';
import { AuditStore } from '../audit/store.ts';
import type { IpcMessage, PeerIdentity, RequestContext } from './types.ts';

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  const peer: PeerIdentity = { pid: 100, uid: 501, gid: 20 };
  return { containerId: 'c-100', pluginName: 'test-plugin', capabilityTags: [], peer, ...overrides };
}

function makeContainerManagerForTest(): {
  manager: ContainerManager;
  runtime: ContainerRuntime;
} {
  const runtime: ContainerRuntime = {
    create: mock.fn(async (config: SandboxConfig) => config.container_id),
    start: mock.fn(async () => {}),
    stop: mock.fn(async () => {}),
    kill: mock.fn(async () => {}),
    remove: mock.fn(async () => {}),
    inspect: mock.fn(async (): Promise<ContainerState> => ({
      Status: 'running',
      Running: true,
      Pid: 999,
      ExitCode: 0,
    })),
    pause: mock.fn(async () => {}),
    resume: mock.fn(async () => {}),
    run: mock.fn(async () => ({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
    })),
    logs: mock.fn(async function* () {
      yield 'log-line-1';
      yield 'log-line-2';
    }),
    createVolume: mock.fn(async (name: string) => name),
    removeVolume: mock.fn(async () => {}),
    ping: mock.fn(async () => true),
  };
  return {
    manager: new ContainerManager(runtime),
    runtime,
  };
}

async function call(
  dispatcher: Dispatcher,
  method: string,
  params: unknown = {},
  ctx: RequestContext = makeCtx(),
): Promise<IpcMessage> {
  return dispatcher.dispatch({ id: `req-${method}`, type: 'request', method, params }, ctx);
}

describe('Dispatcher', () => {
  it('routes test.ping to builtin handler', async () => {
    const dispatcher = new Dispatcher();
    const msg: IpcMessage = { id: '1', type: 'request', method: 'test.ping', params: {} };
    const response = await dispatcher.dispatch(msg, makeCtx());
    assert.strictEqual(response.id, '1');
    assert.strictEqual(response.type, 'response');
    assert.deepStrictEqual(response.result, { pong: true });
    assert.strictEqual(response.error, undefined);
  });

  it('returns error for unknown method', async () => {
    const dispatcher = new Dispatcher();
    const msg: IpcMessage = { id: '2', type: 'request', method: 'no.such.method', params: {} };
    const response = await dispatcher.dispatch(msg, makeCtx());
    assert.ok(response.error?.message.includes('Method not found: no.such.method'));
  });

  it('returns error when method field is missing', async () => {
    const dispatcher = new Dispatcher();
    const msg: IpcMessage = { id: '3', type: 'request' };
    const response = await dispatcher.dispatch(msg, makeCtx());
    assert.ok(response.error?.message.includes('Missing method'));
  });

  it('returns error for non-request message type', async () => {
    const dispatcher = new Dispatcher();
    const msg: IpcMessage = { id: '4', type: 'response', result: {} };
    const response = await dispatcher.dispatch(msg, makeCtx());
    assert.ok(response.error?.message.includes('Only requests supported'));
  });

  it('registered custom handler receives params and ctx', async () => {
    const dispatcher = new Dispatcher();
    dispatcher.register('custom.echo', async (params, ctx) => ({
      params,
      containerId: ctx.containerId,
      peerPid: ctx.peer.pid,
    }));
    const msg: IpcMessage = { id: '5', type: 'request', method: 'custom.echo', params: { x: 99 } };
    const response = await dispatcher.dispatch(msg, makeCtx());
    assert.deepStrictEqual(response.result, {
      params: { x: 99 },
      containerId: 'c-100',
      peerPid: 100,
    });
  });

  it('container.create returns error when no ContainerManager provided', async () => {
    const dispatcher = new Dispatcher();
    const msg: IpcMessage = { id: '6', type: 'request', method: 'container.create', params: { template: 'ai-provider', config: {} } };
    const response = await dispatcher.dispatch(msg, makeCtx());
    assert.ok(response.error?.message.includes('ContainerManager not available'));
  });

  it('routes container.pause/resume/exec/logs to ContainerManager', async () => {
    const { manager, runtime } = makeContainerManagerForTest();
    const dispatcher = new Dispatcher(manager);

    const paused = await call(dispatcher, 'container.pause', { id: 'sandbox-1' });
    assert.equal((paused.result as any).ok, true);

    const resumed = await call(dispatcher, 'container.resume', { id: 'sandbox-1' });
    assert.equal((resumed.result as any).ok, true);

    const execRes = await call(dispatcher, 'container.exec', {
      id: 'sandbox-1',
      command: ['echo', 'ok'],
      opts: { timeout: 300 },
    });
    assert.equal((execRes.result as any).exitCode, 0);
    assert.equal((execRes.result as any).stdout, 'ok\n');

    const logsRes = await call(dispatcher, 'container.logs', { id: 'sandbox-1', tail: 10 });
    assert.deepEqual((logsRes.result as any).lines, ['log-line-1', 'log-line-2']);

    assert.equal((runtime.pause as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((runtime.resume as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((runtime.run as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((runtime.logs as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it('persists session transitions through session API', async () => {
    const machine = new TddStateMachine({ log: () => {} });
    let persistCalls = 0;
    let lastState = machine.getState();
    const dispatcher = new Dispatcher(undefined, {
      stateMachine: machine,
      persistState: (state) => {
        persistCalls += 1;
        lastState = state;
      },
    });

    const submit = await call(dispatcher, 'session.submit_task');
    assert.equal((submit.result as any).state, 'planning');

    const planning = await call(dispatcher, 'session.complete_planning');
    assert.equal((planning.result as any).state, 'test_writing');

    const register = await call(dispatcher, 'session.register_test_file', { path: 'tests/a.test.ts' });
    assert.equal((register.result as any).test_files.length, 1);

    const run = await call(dispatcher, 'session.complete_test_writing');
    assert.equal((run.result as any).state, 'test_running');

    assert.equal(persistCalls, 4);
    assert.equal(lastState.state, 'test_running');
  });

  it('tool.authorize blocks writes in early state-machine phases', async () => {
    const machine = new TddStateMachine({ log: () => {} });
    const dispatcher = new Dispatcher(undefined, { stateMachine: machine });
    const res = await call(dispatcher, 'tool.authorize', {
      tool: 'fs.write',
      target_path: 'src/app.ts',
    });
    assert.equal((res.result as any).allowed, false);
    assert.equal((res.result as any).layer, 'state');
  });

  it('tool.authorize enforces require_review for protected bootstrap path', async () => {
    const issuer = new TokenIssuer();
    const policy = new PolicyEngine(issuer);
    const dispatcher = new Dispatcher(undefined, { policyEngine: policy });
    const res = await call(dispatcher, 'tool.authorize', {
      tool: 'fs.write',
      target_path: 'src/bootstrap/index.ts',
    });
    assert.equal((res.result as any).allowed, false);
    assert.equal((res.result as any).decision, 'require_review');
  });

  it('tool.authorize allows high-risk operation with valid token', async () => {
    const issuer = new TokenIssuer();
    const policy = new PolicyEngine(issuer);
    const token = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.write',
      pathGlob: ['src/safe.ts'],
    });
    const dispatcher = new Dispatcher(undefined, { policyEngine: policy });
    const res = await call(dispatcher, 'tool.authorize', {
      tool: 'fs.write',
      target_path: 'src/safe.ts',
      token,
    });
    assert.equal((res.result as any).allowed, true);
    assert.equal((res.result as any).decision, 'allow');
  });

  it('tool.authorize enforces state -> policy -> token layering in order', async () => {
    const issuer = new TokenIssuer();
    const policy = new PolicyEngine(issuer);
    const machine = new TddStateMachine({ log: () => {} });
    const dispatcher = new Dispatcher(undefined, {
      policyEngine: policy,
      stateMachine: machine,
    });

    // Move machine to coding state (where fs.write can pass state gate for source files).
    machine.submitTask();
    machine.completePlanning();
    machine.registerTestFile('tests/flow.test.ts');
    machine.completeTestWriting();
    machine.reportTestResult(false);

    // 1) State gate deny has highest precedence: test file writes are blocked in coding.
    const blockedByState = await call(dispatcher, 'tool.authorize', {
      tool: 'fs.write',
      target_path: 'tests/flow.test.ts',
    });
    assert.equal((blockedByState.result as any).allowed, false);
    assert.equal((blockedByState.result as any).layer, 'state');

    // 2) Policy gate can still deny/review even with a valid token.
    const protectedToken = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.write',
      pathGlob: ['src/kernel/index.ts'],
    });
    const blockedByPolicy = await call(dispatcher, 'tool.authorize', {
      tool: 'fs.write',
      target_path: 'src/kernel/index.ts',
      token: protectedToken,
    });
    assert.equal((blockedByPolicy.result as any).allowed, false);
    assert.equal((blockedByPolicy.result as any).layer, 'policy');
    assert.equal((blockedByPolicy.result as any).decision, 'require_review');

    // 3) Token fast-path allows operation only after state/policy checks pass.
    const safeToken = issuer.issue({
      containerId: 'c-100',
      peerPid: 100,
      syscall: 'fs.write',
      pathGlob: ['src/safe.ts'],
    });
    const allowed = await call(dispatcher, 'tool.authorize', {
      tool: 'fs.write',
      target_path: 'src/safe.ts',
      token: safeToken,
    });
    assert.equal((allowed.result as any).allowed, true);
    assert.equal((allowed.result as any).layer, 'policy');
    assert.equal((allowed.result as any).decision, 'allow');
  });

  it('token.issue and token.revoke work through IPC handlers', async () => {
    const issuer = new TokenIssuer();
    const dispatcher = new Dispatcher(undefined, { tokenIssuer: issuer });
    const issued = await call(dispatcher, 'token.issue', { syscall: 'custom.op' });
    const tokenId = (issued.result as any).tokenId;
    assert.equal(typeof tokenId, 'string');

    const revoked = await call(dispatcher, 'token.revoke', { tokenId });
    assert.equal((revoked.result as any).ok, true);
  });

  it('audit.verify reports valid chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatcher-audit-'));
    const store = new AuditStore(join(dir, 'audit.db'));
    const logger = new AuditLogger(store, { flushThreshold: 1, flushInterval: 1000 });
    logger.log({
      category: 'tool',
      action: 'test.action',
      actor: 'tester',
      detail: {},
      decision: 'allow',
    });

    const dispatcher = new Dispatcher(undefined, { audit: logger });
    const res = await call(dispatcher, 'audit.verify', { lastN: 10 });
    assert.equal((res.result as any).valid, true);

    logger.close();
  });
});
