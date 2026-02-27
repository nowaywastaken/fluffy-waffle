// src/kernel/ipc/transport.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IpcServer } from './transport.ts';
import { ProtocolHandler } from './protocol.ts';
import type { IpcMessage } from './types.ts';

const TEST_SOCKET = path.join(os.tmpdir(), `ipc-transport-test-${process.pid}.sock`);

async function sendAndReceive(socketPath: string, msg: IpcMessage): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const handler = new ProtocolHandler();
    const timer = setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
    client.on('connect', () => { client.write(ProtocolHandler.encode(msg)); });
    client.on('data', (chunk) => {
      const msgs = handler.handleData(chunk);
      if (msgs.length > 0) {
        clearTimeout(timer);
        client.destroy();
        resolve(msgs[0]);
      }
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

describe('IpcServer', () => {
  let server: IpcServer;

  before(async () => {
    if (fs.existsSync(TEST_SOCKET)) fs.unlinkSync(TEST_SOCKET);
    server = new IpcServer(TEST_SOCKET);
    server.setHandler(async (msg, ctx, reply) => {
      reply({
        id: msg.id,
        type: 'response',
        result: { method: msg.method, peerPid: ctx.peer.pid },
      });
    });
    await server.listen();
  });

  after(async () => {
    await server.close();
    if (fs.existsSync(TEST_SOCKET)) fs.unlinkSync(TEST_SOCKET);
  });

  it('creates socket file with 600 permissions', () => {
    const stat = fs.statSync(TEST_SOCKET);
    const mode = (stat.mode & 0o777).toString(8);
    assert.strictEqual(mode, '600');
  });

  it('routes message to handler and replies', async () => {
    const request: IpcMessage = { id: 'r-1', type: 'request', method: 'test.echo' };
    const response = await sendAndReceive(TEST_SOCKET, request);
    assert.strictEqual(response.id, 'r-1');
    assert.strictEqual(response.type, 'response');
    assert.strictEqual((response.result as any).method, 'test.echo');
  });

  it('ctx.peer.pid is a positive integer (real peer identity)', async () => {
    const request: IpcMessage = { id: 'r-2', type: 'request', method: 'test.peer' };
    const response = await sendAndReceive(TEST_SOCKET, request);
    const pid = (response.result as any).peerPid;
    assert.ok(typeof pid === 'number' && pid > 0, `Expected positive pid, got ${pid}`);
  });
});
