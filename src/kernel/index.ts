// src/kernel/index.ts
import { PolicyEngine } from './security/engine.ts';
import { TokenIssuer } from './security/token.ts';
import { IpcServer } from './ipc/transport.ts';
import { Dispatcher } from './ipc/dispatcher.ts';
import { ContainerManager, DockerAdapter } from './container/index.ts';

async function main(): Promise<void> {
  console.log('--- Fluffy Waffle Kernel L1 ---');

  const tokenIssuer = new TokenIssuer();
  const policy = new PolicyEngine(tokenIssuer);
  console.log('Security Policy Engine initialized.');

  const runtime = new DockerAdapter();
  const containerManager = new ContainerManager(runtime);
  console.log('Container Manager initialized.');

  const socketPath = '/tmp/fluffy-kernel.sock';
  const ipc = new IpcServer(socketPath);
  const dispatcher = new Dispatcher(containerManager);
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

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await ipc.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Kernel startup failed:', err);
  process.exit(1);
});
