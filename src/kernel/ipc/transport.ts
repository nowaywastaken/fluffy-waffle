// src/kernel/ipc/transport.ts
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { getPeerIdentity } from './peer.ts';
import { ProtocolHandler } from './protocol.ts';
import type { IpcMessage, PeerIdentity, RequestContext } from './types.ts';

export type MessageHandler = (
  msg: IpcMessage,
  ctx: RequestContext,
  reply: (response: IpcMessage) => void,
) => Promise<void>;

export class IpcServer {
  private socketPath: string;
  private server: net.Server;
  private connections = new Set<net.Socket>();
  private handler?: MessageHandler;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.server = net.createServer(sock => this.handleConnection(sock));
  }

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  async listen(): Promise<void> {
    await this.prepareSocketPath();
    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const conn of this.connections) conn.destroy();
    this.connections.clear();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    let peer: PeerIdentity;
    try {
      peer = getPeerIdentity(socket);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`IPC: rejected connection — ${msg}`);
      socket.destroy();
      return;
    }

    this.connections.add(socket);
    const protocol = new ProtocolHandler();
    const ctx: RequestContext = {
      containerId: `container-${peer.pid}`,
      pluginName: 'unknown',
      capabilityTags: [],
      peer,
    };
    const reply = (response: IpcMessage) => {
      socket.write(ProtocolHandler.encode(response));
    };

    socket.on('data', async chunk => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const msg of protocol.handleData(buf)) {
        await this.handler?.(msg, ctx, reply);
      }
    });
    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', err => console.error('IPC socket error:', err.message));
  }

  private async prepareSocketPath(): Promise<void> {
    const parentDir = path.dirname(this.socketPath);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(parentDir, 0o700);

    if (!fs.existsSync(this.socketPath)) return;

    const stat = fs.lstatSync(this.socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to use non-socket path: ${this.socketPath}`);
    }

    const inUse = await this.isSocketActive();
    if (inUse) {
      throw new Error(`Socket path already in use: ${this.socketPath}`);
    }

    fs.unlinkSync(this.socketPath);
  }

  private async isSocketActive(): Promise<boolean> {
    return new Promise((resolve) => {
      const client = net.createConnection(this.socketPath);
      let settled = false;

      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        client.destroy();
        resolve(value);
      };

      const timer = setTimeout(() => settle(true), 200);
      timer.unref();

      client.on('connect', () => {
        clearTimeout(timer);
        settle(true);
      });

      client.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          settle(false);
          return;
        }
        settle(true);
      });
    });
  }
}
