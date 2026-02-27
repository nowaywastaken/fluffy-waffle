// src/kernel/ipc/dispatcher.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from './dispatcher.ts';
import type { IpcMessage, PeerIdentity, RequestContext } from './types.ts';

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  const peer: PeerIdentity = { pid: 100, uid: 501, gid: 20 };
  return { containerId: 'c-100', pluginName: 'test-plugin', capabilityTags: [], peer, ...overrides };
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
});
