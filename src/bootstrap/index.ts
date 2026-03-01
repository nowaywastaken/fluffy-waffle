import { spawn, spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

/**
 * Bootstrap Layer (389 LOC / 500 LOC budget)
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

function detectContainerRuntime(preference: string): string | null {
  const runtimes = preference === 'auto' ? ['docker', 'podman'] : [preference];
  for (const runtime of runtimes) {
    const result = spawnSync(runtime, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) {
      return runtime;
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
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for argument: ${arg}`);
      }
      args.config = value;
      i++;
    } else if (arg === '--runtime' || arg === '-r') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for argument: ${arg}`);
      }
      args.runtime = value;
      i++;
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

function buildPingFrame(): Buffer {
  const msg = {
    id: 'bootstrap-ping-1',
    type: 'request' as const,
    method: 'test.ping',
    params: {},
  };
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function parsePongFrame(data: Buffer): boolean {
  if (data.length < 4) return false;
  const length = data.readUInt32BE(0);
  if (data.length < 4 + length) return false;
  try {
    const msg = JSON.parse(data.subarray(4, 4 + length).toString('utf8'));
    return msg.type === 'response' && msg.result?.pong === true;
  } catch {
    return false;
  }
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
      client.write(buildPingFrame());
    });

    client.on('data', (data) => {
      clearTimeout(timer);
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      if (parsePongFrame(buf)) {
        client.destroy();
        resolve(true);
      } else {
        client.destroy();
        reject(new Error('Invalid pong response'));
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function calculateBackoff(restartCount: number): number {
  return Math.min(1000 * Math.pow(2, restartCount), 4000);
}

function shouldRestart(state: RestartState): boolean {
  const now = Date.now();
  const windowStart = now - state.windowMs;

  // Clean up timestamps outside window
  state.timestamps = state.timestamps.filter(t => t > windowStart);

  // Check if limit exceeded
  if (state.timestamps.length >= state.maxRestarts) {
    return false;
  }

  return true;
}

async function waitForContainerExit(runtime: string, containerName: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(runtime, ['wait', containerName]);
    child.on('close', () => {
      resolve();
    });
  });
}

async function monitorKernel(runtime: string, config: BootstrapConfig): Promise<void> {
  const state: RestartState = {
    count: 0,
    timestamps: [],
    maxRestarts: 3,
    windowMs: 5 * 60 * 1000,
  };

  while (true) {
    try {
      await startKernel(runtime, config);

      await healthCheck({
        socketPath: '/run/fluffy/kernel.sock',
        timeout: 30000,
        retryInterval: 1000,
      });

      console.log('Kernel started successfully');
      state.count = 0;

      await waitForContainerExit(runtime, 'fluffy-waffle-kernel');

      console.error('Kernel container exited unexpectedly');

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Kernel startup failed:', message);
    }

    if (!shouldRestart(state)) {
      const error: StructuredError = {
        level: 'error',
        what: 'Kernel restart limit exceeded',
        why: 'Kernel crashed 3 times within 5 minutes',
        fix: 'Check kernel logs for errors: docker logs fluffy-waffle-kernel',
        context: `Restart attempts: ${state.timestamps.length}`,
      };
      console.error(formatError(error));
      process.exit(1);
    }

    const backoff = calculateBackoff(state.count);
    console.log(`Restarting in ${backoff}ms...`);
    await sleep(backoff);

    state.count++;
    state.timestamps.push(Date.now());
  }
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

  // 2. Enter monitor loop
  await monitorKernel(runtime, config);
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
