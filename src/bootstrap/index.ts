import { execSync, spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

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

function loadConfig(configPath?: string): BootstrapConfig {
  const cfgPath = configPath || path.join(process.cwd(), 'fluffy.yaml');
  let config = { ...DEFAULT_CONFIG };

  if (fs.existsSync(cfgPath)) {
    const content = fs.readFileSync(cfgPath, 'utf8');
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

function formatError(error: StructuredError): string {
  const lines = [
    `${error.level.toUpperCase()}: ${error.what}`,
    `Reason: ${error.why}`,
    `Fix: ${error.fix}`,
  ];

  if (error.context) {
    lines.push(`Context: ${error.context}`);
  }

  return lines.join('\n');
}

function reportNoRuntime(platform: string): void {
  const error: StructuredError = {
    level: 'error',
    what: 'No container runtime detected',
    why: 'Docker or Podman is required but not found in PATH',
    fix: getInstallInstructions(platform),
    context: `Platform: ${platform}`,
  };
  console.error(formatError(error));
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--config' || arg === '-c') {
      args.config = argv[++i];
    } else if (arg === '--runtime' || arg === '-r') {
      args.runtime = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Fluffy Waffle Bootstrap v0.1.0

Usage: fluffy [options]

Options:
  -h, --help              Show this help message
  -v, --version           Show version information
  -c, --config <path>     Path to config file (default: ./fluffy.yaml)
  -r, --runtime <name>    Container runtime (docker|podman|auto)
  `);
}

function buildStartCommand(runtime: string, config: BootstrapConfig): string[] {
  return [
    'run',
    '-d',
    '--name', 'fluffy-waffle-kernel',
    '--rm',
    ...SECURITY_FLAGS,
    ...MOUNT_CONFIG(config.workspaceDir),
    ...NETWORK_CONFIG,
    ...RESOURCE_LIMITS,
    config.kernelImage,
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function healthCheck(config: HealthCheckConfig): Promise<boolean> {
  const startTime = Date.now();

  // Phase 1: Wait for socket file
  while (!fs.existsSync(config.socketPath)) {
    if (Date.now() - startTime > config.timeout) {
      throw new Error('Socket file not created within timeout');
    }
    await sleep(config.retryInterval);
  }

  // Phase 2: Ping/pong
  const client = net.createConnection(config.socketPath);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('Ping timeout'));
    }, 5000);

    client.on('connect', () => {
      const ping = JSON.stringify({ type: 'ping' }) + '\n';
      client.write(ping);
    });

    client.on('data', (data) => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(data.toString());
        if (response.type === 'pong') {
          client.destroy();
          resolve(true);
        } else {
          reject(new Error('Invalid response'));
        }
      } catch (err) {
        reject(new Error('Failed to parse response'));
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function startKernel(runtime: string, config: BootstrapConfig): Promise<void> {
  console.log(`Starting Kernel L1 container using ${runtime}...`);

  const args = buildStartCommand(runtime, config);

  return new Promise((resolve, reject) => {
    const child = spawn(runtime, args, { stdio: 'pipe' });

    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('Container started successfully');
        resolve();
      } else {
        reject(new Error(`Failed to start container (exit code ${code}): ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ${runtime}: ${err.message}`));
    });
  });
}

async function main() {
  console.log('--- Fluffy Waffle Bootstrap ---');

  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log('Fluffy Waffle v0.1.0');
    process.exit(0);
  }

  const config = loadConfig(args.config);
  if (args.runtime) config.runtime = args.runtime;

  // 1. Detect Runtime
  const runtime = detectContainerRuntime(config.runtime);
  if (!runtime) {
    reportNoRuntime(os.platform());
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
