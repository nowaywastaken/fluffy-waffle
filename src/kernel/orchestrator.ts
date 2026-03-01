import * as fs from 'node:fs';
import * as path from 'node:path';
import { PolicyEngine } from './security/engine.ts';
import { TokenIssuer } from './security/token.ts';
import { IpcServer } from './ipc/transport.ts';
import { Dispatcher } from './ipc/dispatcher.ts';
import { ContainerManager, DockerAdapter } from './container/index.ts';
import { AuditLogger, AuditStore } from './audit/index.ts';
import { StateStore, TddStateMachine } from './state/index.ts';
import type { SessionState } from './state/types.ts';

export interface KernelOrchestratorOptions {
  cwd?: string;
  socketPath?: string;
}

export function getDefaultKernelSocketPath(cwd = process.cwd()): string {
  return path.join(cwd, '.fluffy', 'ipc', 'kernel.sock');
}

export class KernelOrchestrator {
  private readonly cwd: string;
  private readonly socketPath: string;

  private audit: AuditLogger | undefined;
  private stateStore: StateStore | undefined;
  private stateMachine: TddStateMachine | undefined;
  private containerManager: ContainerManager | undefined;
  private ipc: IpcServer | undefined;

  private started = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: KernelOrchestratorOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.socketPath = options.socketPath
      ?? process.env.FLUFFY_KERNEL_SOCKET
      ?? getDefaultKernelSocketPath(this.cwd);
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const fluffyDir = path.join(this.cwd, '.fluffy');
    fs.mkdirSync(fluffyDir, { recursive: true });

    const auditStore = new AuditStore(path.join(fluffyDir, 'audit.db'));
    const audit = new AuditLogger(auditStore);
    const stateStore = new StateStore(path.join(fluffyDir, 'state.db'));
    const stateMachine = new TddStateMachine(audit);

    const persistedState = stateStore.load();
    if (persistedState) {
      stateMachine.hydrate(persistedState);
      console.log(`Restored session state: ${persistedState.state} (${persistedState.mode})`);
    }

    const tokenIssuer = new TokenIssuer();
    const policy = new PolicyEngine(tokenIssuer);
    const policyPath = path.join(fluffyDir, 'policy.yaml');
    if (fs.existsSync(policyPath)) {
      policy.loadYamlRules(policyPath);
      console.log(`Loaded policy rules from ${policyPath}`);
    }

    const runtime = new DockerAdapter();
    const containerManager = new ContainerManager(runtime);

    const ipc = new IpcServer(this.socketPath);
    const dispatcher = new Dispatcher(containerManager, {
      policyEngine: policy,
      tokenIssuer,
      stateMachine,
      persistState: (state: SessionState) => stateStore.save(state),
      audit,
    });
    ipc.setHandler(async (msg, ctx, reply) => {
      const response = await dispatcher.dispatch(msg, ctx);
      reply(response);
    });

    await ipc.listen();

    this.audit = audit;
    this.stateStore = stateStore;
    this.stateMachine = stateMachine;
    this.containerManager = containerManager;
    this.ipc = ipc;
    this.started = true;
    console.log(`Kernel IPC listening on ${this.socketPath}`);
  }

  async stop(signal: string): Promise<void> {
    if (!this.started) return;
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = this.doStop(signal).finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  private async doStop(signal: string): Promise<void> {
    console.log(`Shutting down (${signal})...`);

    try {
      if (this.stateStore && this.stateMachine) {
        this.stateStore.save(this.stateMachine.getState());
      }
    } catch (err) {
      console.warn('Failed to persist session state on shutdown:', err);
    }

    try {
      await this.ipc?.close();
    } catch (err) {
      console.warn('Failed to close IPC server:', err);
    }

    try {
      await this.containerManager?.shutdown();
    } catch (err) {
      console.warn('Failed to shutdown container manager:', err);
    }

    try {
      this.stateStore?.close();
    } catch (err) {
      console.warn('Failed to close state store:', err);
    }

    try {
      this.audit?.close();
    } catch (err) {
      console.warn('Failed to close audit logger:', err);
    }

    this.started = false;
  }
}
