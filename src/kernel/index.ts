// src/kernel/index.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PolicyEngine } from './security/engine.ts';
import { TokenIssuer } from './security/token.ts';
import { IpcServer } from './ipc/transport.ts';
import { Dispatcher } from './ipc/dispatcher.ts';
import { ContainerManager, DockerAdapter } from './container/index.ts';
import { AuditLogger, AuditStore } from './audit/index.ts';
import { StateStore, TddStateMachine } from './state/index.ts';

async function main(): Promise<void> {
  console.log('--- Fluffy Waffle Kernel L1 ---');
  const fluffyDir = path.join(process.cwd(), '.fluffy');
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
  console.log('Security Policy Engine initialized.');

  const runtime = new DockerAdapter();
  const containerManager = new ContainerManager(runtime);
  console.log('Container Manager initialized.');

  const socketPath = '/tmp/fluffy-kernel.sock';
  const ipc = new IpcServer(socketPath);
  const dispatcher = new Dispatcher(containerManager, {
    policyEngine: policy,
    tokenIssuer,
    stateMachine,
    persistState: (state) => stateStore.save(state),
    audit,
  });
  ipc.setHandler(async (msg, ctx, reply) => {
    const response = await dispatcher.dispatch(msg, ctx);
    reply(response);
  });

  try {
    await ipc.listen();
    console.log(`Kernel IPC listening on ${socketPath}`);
  } catch (err) {
    console.error('Failed to start IPC server:', err);
    process.exit(1);
  }

  console.log('Kernel ready and waiting for connections...');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Shutting down (${signal})...`);
    try {
      stateStore.save(stateMachine.getState());
    } catch (err) {
      console.warn('Failed to persist session state on shutdown:', err);
    }
    try {
      await ipc.close();
    } finally {
      stateStore.close();
      audit.close();
    }
  };

  process.on('SIGINT', async () => {
    await shutdown('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdown('SIGTERM');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Kernel startup failed:', err);
  process.exit(1);
});
