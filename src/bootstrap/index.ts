import { execSync, spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Bootstrap Layer (< 500 LOC)
 * Trust Anchor of the Fluffy Waffle system.
 */

interface BootstrapConfig {
  runtime: string;
  kernelImage: string;
  workspaceDir: string;
  maxRestarts: number;
}

interface HealthCheckConfig {
  socketPath: string;
  timeout: number;
  retryInterval: number;
}

interface RestartState {
  count: number;
  timestamps: number[];
  maxRestarts: number;
  windowMs: number;
}

interface StructuredError {
  level: 'error' | 'warn' | 'info';
  what: string;
  why: string;
  fix: string;
  context?: string;
}

interface CliArgs {
  help: boolean;
  version: boolean;
  config?: string;
  runtime?: string;
}

const DEFAULT_CONFIG: BootstrapConfig = {
  runtime: process.env.CONTAINER_RUNTIME || 'auto',
  kernelImage: 'fluffy-waffle-kernel:latest',
  workspaceDir: process.cwd(),
  maxRestarts: 3,
};

const SECURITY_FLAGS = [
  '--privileged',
  '--security-opt', 'apparmor=unconfined',
  '--security-opt', 'seccomp=unconfined',
  '--cap-add', 'SYS_ADMIN',
] as const;

const MOUNT_CONFIG = (workspaceDir: string) => [
  '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
  '-v', `${workspaceDir}:/workspace:rw`,
  '-v', 'fluffy-ipc:/run/fluffy',
] as const;

const NETWORK_CONFIG = [
  '--network', 'bridge',
] as const;

const RESOURCE_LIMITS = [
  '--memory', '2g',
  '--cpus', '2',
] as const;

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*(\w+)\s*:\s*(.+)\s*$/);
    if (match && match[1] && match[2]) {
      result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

function loadConfig(): BootstrapConfig {
  const configPath = path.join(process.cwd(), 'fluffy.yaml');
  let config = { ...DEFAULT_CONFIG };

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = parseSimpleYaml(content);
    if (parsed['runtime']) config.runtime = parsed['runtime'];
    if (parsed['kernel_image']) config.kernelImage = parsed['kernel_image'];
    if (parsed['max_restarts']) config.maxRestarts = parseInt(parsed['max_restarts'], 10);
  }

  return config;
}

function detectContainerRuntime(preference: string) {
  const runtimes = preference === 'auto' ? ['docker', 'podman'] : [preference];
  for (const runtime of runtimes) {
    try {
      execSync(`${runtime} --version`, { stdio: 'ignore' });
      return runtime;
    } catch (e) {
      // Continue
    }
  }
  return null;
}

function getInstallInstructions(platform: string) {
  switch (platform) {
    case 'darwin': return 'brew install --cask docker';
    case 'linux': return 'apt install docker.io OR dnf install podman';
    case 'win32': return 'Please install Docker Desktop and enable WSL2 backend.';
    default: return 'Please install Docker or Podman for your platform.';
  }
}

async function startKernel(runtime: string, config: BootstrapConfig) {
  console.log(`Starting Kernel L1 container using ${runtime}...`);
  
  // In a real implementation, this would be a docker run command
  // For now, we'll just simulate it or prepare the command
  const args = [
    'run', '-d',
    '--name', 'fluffy-waffle-kernel',
    '--privileged', // L1 needs to manage L2 containers
    '-v', `${config.workspaceDir}:/workspace`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    config.kernelImage
  ];

  console.log(`Command: ${runtime} ${args.join(' ')}`);
  // Since we don't have the image yet, we won't actually run it
  return true;
}

async function main() {
  console.log('--- Fluffy Waffle Bootstrap ---');

  const config = loadConfig();
  
  // 1. Detect Runtime
  const runtime = detectContainerRuntime(config.runtime);
  if (!runtime) {
    console.error('Error: No container runtime detected.');
    console.error(getInstallInstructions(os.platform()));
    process.exit(1);
  }
  console.log(`Using runtime: ${runtime}`);

  // 2. Start Kernel
  await startKernel(runtime, config);

  console.log('Bootstrap phase complete.');
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
