import { execFileNoThrow } from '../../utils/execFileNoThrow.ts';
import type { ContainerRuntime } from './types.ts';
import type { SandboxLifecycle } from './lifecycle.ts';

interface ContainerEntry {
  id: string;
  name: string;
}

async function listContainersWithPrefix(
  binary: string,
  prefix: string,
): Promise<ContainerEntry[]> {
  const result = await execFileNoThrow(binary, [
    'ps', '-a',
    '--filter', `name=${prefix}`,
    '--format', '{{.ID}}\t{{.Names}}',
  ]);

  if (result.status !== 0 || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split('\n')
    .map(line => {
      const [id, name] = line.split('\t');
      return { id: (id ?? '').trim(), name: (name ?? '').trim() };
    })
    .filter(({ id, name }) => id && name);
}

async function cleanupOrphan(
  runtime: ContainerRuntime,
  id: string,
  name: string,
): Promise<void> {
  console.warn(`Orphan container found: ${name} (${id}), cleaning up...`);
  await runtime.stop(id, 5000).catch(() => {});
  await runtime.remove(id).catch(() => {});
  await runtime.removeVolume(`vol-${name}`).catch(() => {});
}

export async function scanOrphans(
  binary: string,
  runtime: ContainerRuntime,
  lifecycle: SandboxLifecycle,
): Promise<void> {
  const containers = await listContainersWithPrefix(binary, 'fw-sandbox-');
  const active = new Set(lifecycle.active());

  for (const { id, name } of containers) {
    if (!active.has(name)) {
      await cleanupOrphan(runtime, id, name).catch(err =>
        console.error(`Failed to clean orphan ${name}:`, (err as Error).message),
      );
    }
  }
}
