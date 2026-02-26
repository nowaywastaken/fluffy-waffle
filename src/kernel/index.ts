import { PolicyEngine } from './security/policy.js';
import { IpcServer } from './ipc/transport.js';
import { ContainerManager } from './container/manager.js';
import { Dispatcher } from './ipc/dispatcher.js';

async function main() {
  console.log('--- Fluffy Waffle Kernel L1 ---');
  
  // 1. Initialize Security Policy
  const policy = new PolicyEngine();
  console.log('Security Policy Engine initialized.');

  // 2. Initialize Container Manager
  const containerManager = new ContainerManager('docker');
  console.log('Container Manager initialized.');

  // 3. Initialize Dispatcher
  const dispatcher = new Dispatcher(policy, containerManager);
  console.log('Dispatcher initialized.');

  // 4. Start IPC Server
  const socketPath = '/tmp/fluffy-kernel.sock';
  const ipc = new IpcServer(socketPath);
  ipc.setDispatcher(dispatcher);
  
  try {
    await ipc.listen();
    console.log(`Kernel IPC listening on ${socketPath}`);
  } catch (err) {
    console.error('Failed to start IPC server:', err);
    process.exit(1);
  }

  // Keep alive
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
