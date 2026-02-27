import type { SandboxConfig } from './types.ts';

export const SANDBOX_TEMPLATES: Record<string, Partial<SandboxConfig>> = {
  'ai-provider': {
    network_mode: 'restricted',
    memory_limit: '256MiB',
    cpu_limit: 0.5,
    max_pids: 10,
    max_duration: 120_000,
    seccomp_profile: 'strict',
  },
  'code-executor': {
    network_mode: 'none',
    memory_limit: '1GiB',
    cpu_limit: 1.0,
    max_pids: 100,
    max_duration: 300_000,
    seccomp_profile: 'standard',
  },
  'policy-sandbox': {
    network_mode: 'none',
    memory_limit: '128MiB',
    cpu_limit: 0.25,
    max_pids: 5,
    max_duration: 100,
    seccomp_profile: 'strict',
  },
  'integration-test': {
    network_mode: 'restricted',
    memory_limit: '1GiB',
    cpu_limit: 1.0,
    max_pids: 100,
    max_duration: 300_000,
    seccomp_profile: 'standard-net',
  },
};

export function buildConfig(
  template: string,
  overrides: Partial<SandboxConfig>,
): SandboxConfig {
  const base = SANDBOX_TEMPLATES[template];
  if (!base) throw new Error(`Unknown template: ${template}`);
  return { ...base, ...overrides } as SandboxConfig;
}
