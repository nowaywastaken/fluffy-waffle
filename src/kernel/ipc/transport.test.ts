// src/kernel/ipc/transport.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { IpcServer } from './transport.ts';
import { ProtocolHandler } from './protocol.ts';
import type { IpcMessage } from './types.ts';

const TEST_DIR = mkdtempSync(path.join(os.tmpdir(), `ipc-transport-test-${process.pid}-`));
const TEST_SOCKET = path.join(TEST_DIR, 'kernel.sock');

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
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates socket file with 600 permissions', () => {
    const stat = fs.statSync(TEST_SOCKET);
    const mode = (stat.mode & 0o777).toString(8);
    assert.strictEqual(mode, '600');
  });

  it('creates parent directory with 700 permissions', () => {
    const stat = fs.statSync(TEST_DIR);
    const mode = (stat.mode & 0o777).toString(8);
    assert.strictEqual(mode, '700');
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

  it('rejects non-socket existing path', async () => {
    const badPath = path.join(TEST_DIR, 'not-a-socket');
    fs.writeFileSync(badPath, 'x');
    const badServer = new IpcServer(badPath);
    await assert.rejects(() => badServer.listen(), /non-socket path/i);
    fs.unlinkSync(badPath);
  });

  it('rejects active socket path instead of unlinking it', async () => {
    const busyPath = path.join(TEST_DIR, 'busy.sock');
    const holder = net.createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(busyPath, () => resolve());
    });

    const contender = new IpcServer(busyPath);
    await assert.rejects(() => contender.listen(), /already in use/i);

    await new Promise<void>((resolve) => holder.close(() => resolve()));
    if (fs.existsSync(busyPath)) fs.unlinkSync(busyPath);
  });

  it('reuses stale socket path after cleanup', async () => {
    const stalePath = path.join(TEST_DIR, 'stale.sock');

    const child = spawn(process.execPath, [
      '-e',
      [
        'const net = require(\"node:net\");',
        'const socketPath = process.argv[1];',
        'const server = net.createServer();',
        'server.listen(socketPath, () => process.stdout.write(\"ready\\n\"));',
        'setInterval(() => {}, 1000);',
      ].join(''),
      stalePath,
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.once('data', () => resolve());
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(fs.existsSync(stalePath), true);

    const replacement = new IpcServer(stalePath);
    replacement.setHandler(async (msg, _ctx, reply) => {
      reply({ id: msg.id, type: 'response', result: { ok: true } });
    });
    await replacement.listen();
    await replacement.close();
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  });
});
