import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProtocolHandler } from '../kernel/ipc/protocol.ts';
import {
  parseCommand,
  parseGlobalArgs,
  parseJson,
  preflightSocketPath,
  request,
} from './index.ts';

const tempDirs: string[] = [];
const sockets: string[] = [];
const servers: net.Server[] = [];

function createTempDir(prefix = 'cli-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`));
  tempDirs.push(dir);
  return dir;
}

function createSocketPath(dir: string, name = 'kernel.sock'): string {
  const socket = path.join(dir, name);
  sockets.push(socket);
  return socket;
}

async function listenServer(socketPath: string, onConn?: (socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer((socket) => {
    onConn?.(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

class FakeSocket extends EventEmitter {
  write(_chunk: Buffer): boolean {
    return true;
  }

  end(): this {
    this.emit('close');
    return this;
  }

  destroy(): this {
    this.emit('close');
    return this;
  }
}

afterEach(async () => {
  for (const server of servers.splice(0, servers.length)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const socket of sockets.splice(0, sockets.length)) {
    if (fs.existsSync(socket)) fs.unlinkSync(socket);
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cli/index', () => {
  it('parseGlobalArgs extracts --socket and preserves remaining args', () => {
    const parsed = parseGlobalArgs(['--socket', '/tmp/s.sock', 'ping']);
    assert.equal(parsed.socketPath, '/tmp/s.sock');
    assert.deepEqual(parsed.args, ['ping']);
  });

  it('parseCommand maps session set-mode to session.set_mode', () => {
    const parsed = parseCommand(['session', 'set-mode', 'debug']);
    assert.equal(parsed.method, 'session.set_mode');
    assert.deepEqual(parsed.params, { mode: 'debug' });
  });

  it('parseJson throws a labeled error on invalid JSON', () => {
    assert.throws(() => parseJson('{', 'jsonParams'), /jsonParams must be valid JSON/i);
  });

  it('preflightSocketPath rejects non-socket paths', () => {
    const dir = createTempDir();
    const filePath = path.join(dir, 'not-socket');
    fs.writeFileSync(filePath, 'x');
    assert.throws(() => preflightSocketPath(filePath), /not a Unix socket/i);
  });

  it('preflightSocketPath warns for world-writable parent directories', async () => {
    const dir = createTempDir();
    fs.chmodSync(dir, 0o777);
    const socketPath = createSocketPath(dir);
    await listenServer(socketPath);

    const warnings: string[] = [];
    preflightSocketPath(socketPath, (message) => warnings.push(message));
    assert.equal(warnings.length > 0, true);
    assert.match(warnings[0] ?? '', /world-writable/i);
  });

  it('request times out when connection is established but no response arrives', async () => {
    const socket = new FakeSocket();
    setTimeout(() => socket.emit('connect'), 1);

    await assert.rejects(
      request('/unused.sock', 'test.ping', {}, {
        timeoutMs: 50,
        skipPreflight: true,
        connect: () => socket as unknown as net.Socket,
      }),
      /IPC timeout/i,
    );
  });

  it('request resolves when matching response frame is received', async () => {
    const socket = new FakeSocket();
    const originalWrite = socket.write.bind(socket);
    socket.write = ((chunk: Buffer) => {
      const protocol = new ProtocolHandler();
      const [req] = protocol.handleData(chunk);
      const response = ProtocolHandler.encode({
        id: req?.id ?? 'unknown',
        type: 'response',
        result: { pong: true },
      });
      setTimeout(() => socket.emit('data', response), 1);
      return originalWrite(chunk);
    }) as typeof socket.write;

    setTimeout(() => socket.emit('connect'), 1);

    const result = await request('/unused.sock', 'test.ping', {}, {
      timeoutMs: 200,
      skipPreflight: true,
      connect: () => socket as unknown as net.Socket,
    });
    assert.deepEqual(result.result, { pong: true });
  });
});
