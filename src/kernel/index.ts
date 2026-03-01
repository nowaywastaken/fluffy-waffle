import { KernelOrchestrator } from './orchestrator.ts';

async function main(): Promise<void> {
  console.log('--- Fluffy Waffle Kernel L1 ---');

  const orchestrator = new KernelOrchestrator();
  await orchestrator.start();
  console.log('Kernel ready and waiting for connections...');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await orchestrator.stop(signal);
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
