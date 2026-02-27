// src/kernel/security/extension.ts
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProtocolHandler } from '../ipc/protocol.ts';
import type { IpcMessage } from '../ipc/types.ts';
import type { SyscallContext, PolicyDecision } from './types.ts';

const EVAL_TIMEOUT_MS = 100;
const RESTART_COOLDOWN_MS = 30_000;

export interface StartOptions {
  command?: string;  // defaults to 'deno'; set to 'node' for testing
}

export class ExtensionSandbox {
  private childProcess?: ChildProcess;
  private socket?: net.Socket;
  private socketPath: string;
  private ready = false;
  private stopped = false;
  private lastCrash = 0;
  private scriptPath?: string;
  private command = 'deno';
  private pending = new Map<string, (decision: PolicyDecision) => void>();

  constructor() {
    this.socketPath = path.join(os.tmpdir(), `fw-ext-${process.pid}-${randomUUID()}.sock`);
  }

  async start(scriptPath: string, options: StartOptions = {}): Promise<void> {
    this.scriptPath = scriptPath;
    this.command = options.command ?? 'deno';
    await this.spawnProcess();
    await this.warmup();
  }

  async evaluate(ctx: SyscallContext): Promise<PolicyDecision> {
    if (!this.ready) return 'pass';
    return new Promise<PolicyDecision>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve('pass');  // timeout → pass
      }, EVAL_TIMEOUT_MS);
      (timer as NodeJS.Timeout).unref();
      this.pending.set(id, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
      const msg: IpcMessage = { id, type: 'request', method: 'ext.evaluate', params: ctx };
      this.socket?.write(ProtocolHandler.encode(msg));
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.stopped = true;
    this.socket?.destroy();
    this.childProcess?.kill();
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
  }

  private async spawnProcess(): Promise<void> {
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Extension connection timeout')), 5000);

      const server = net.createServer((sock) => {
        clearTimeout(timeout);
        this.socket = sock;
        const protocol = new ProtocolHandler();
        server.close();

        sock.on('data', (chunk) => {
          for (const msg of protocol.handleData(chunk)) {
            if (msg.type === 'response') {
              const resolver = this.pending.get(msg.id);
              if (resolver) {
                this.pending.delete(msg.id);
                resolver((msg.result as PolicyDecision) ?? 'pass');
              }
            }
          }
        });
        sock.on('error', () => {});
        resolve();
      });

      server.listen(this.socketPath, () => {
        server.unref();
        fs.chmodSync(this.socketPath, '600');
        const args = this.command === 'deno'
          ? ['run', `--allow-read=${this.scriptPath}`, this.scriptPath!, this.socketPath]
          : [this.scriptPath!, this.socketPath];

        this.childProcess = spawn(this.command, args, { stdio: 'inherit' });
        this.childProcess.on('exit', () => this.handleCrash());
      });

      server.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  private async warmup(): Promise<void> {
    await new Promise(resolve => {
      const t = setTimeout(resolve, 100);
      (t as NodeJS.Timeout).unref();
    });
    const ctx: SyscallContext = {
      type: '__warmup__',
      args: {},
      caller: { containerId: '', pluginName: '', capabilityTags: [], peer: { pid: 0, uid: 0, gid: 0 } },
    };
    await this.evaluate(ctx);
    this.ready = true;
  }

  private handleCrash(): void {
    if (this.stopped) return;
    this.ready = false;
    for (const [id, resolver] of this.pending) {
      this.pending.delete(id);
      resolver('deny');
    }

    const now = Date.now();
    if (now - this.lastCrash < RESTART_COOLDOWN_MS) {
      console.error('[extension] Second crash within cooldown, extension disabled');
      return;
    }
    this.lastCrash = now;
    console.warn('[extension] Deno sandbox crashed, attempting restart');
    this.spawnProcess()
      .then(() => this.warmup())
      .catch(() => console.error('[extension] Restart failed, extension disabled'));
  }
}
