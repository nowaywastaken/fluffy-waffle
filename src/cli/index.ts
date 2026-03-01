#!/usr/bin/env node
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolHandler } from '../kernel/ipc/protocol.ts';
import type { IpcMessage } from '../kernel/ipc/types.ts';

export const DEFAULT_SOCKET = process.env.FLUFFY_KERNEL_SOCKET || path.join(process.cwd(), '.fluffy', 'ipc', 'kernel.sock');

export interface CommandSpec {
  method: string;
  params: Record<string, unknown>;
}

export function printHelp(): void {
  console.log(`Fluffy Waffle CLI (MVP)

Usage:
  fluffy-cli [--socket <path>] ping
  fluffy-cli [--socket <path>] rpc <method> [jsonParams]
  fluffy-cli [--socket <path>] session <subcommand> [args]
  fluffy-cli [--socket <path>] tool-authorize <tool> [targetPath] [jsonArgs]
  fluffy-cli [--socket <path>] container <subcommand> [args]

Session subcommands:
  get
  submit-task
  complete-planning
  register-test-file <path>
  complete-test-writing
  report-test-result <true|false>
  complete-coding
  set-mode <strict|explore|debug>
  reset

Container subcommands:
  create <template> <jsonConfig>
  destroy <id>
  state <id>
  pause <id>
  resume <id>
  exec <id> <jsonArrayCommand> [jsonOpts]
  logs <id> [--follow] [--tail <n>]
`);
}

export function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} must be valid JSON: ${message}`);
  }
}

function parseBoolean(raw: string, label: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${label} must be "true" or "false"`);
}

export function parseGlobalArgs(argv: string[]): { socketPath: string; args: string[] } {
  const args: string[] = [];
  let socketPath = DEFAULT_SOCKET;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--socket') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--socket requires a path value');
      }
      socketPath = value;
      i += 1;
      continue;
    }
    args.push(arg);
  }
  return { socketPath, args };
}

function parseSessionCommand(args: string[]): CommandSpec {
  const sub = args[0];
  switch (sub) {
    case 'get':
      return { method: 'session.get', params: {} };
    case 'submit-task':
      return { method: 'session.submit_task', params: {} };
    case 'complete-planning':
      return { method: 'session.complete_planning', params: {} };
    case 'register-test-file':
      if (!args[1]) throw new Error('session register-test-file requires <path>');
      return { method: 'session.register_test_file', params: { path: args[1] } };
    case 'complete-test-writing':
      return { method: 'session.complete_test_writing', params: {} };
    case 'report-test-result':
      if (!args[1]) throw new Error('session report-test-result requires <true|false>');
      return {
        method: 'session.report_test_result',
        params: { passed: parseBoolean(args[1], 'report-test-result value') },
      };
    case 'complete-coding':
      return { method: 'session.complete_coding', params: {} };
    case 'set-mode':
      if (!args[1]) throw new Error('session set-mode requires <strict|explore|debug>');
      return { method: 'session.set_mode', params: { mode: args[1] } };
    case 'reset':
      return { method: 'session.reset', params: {} };
    default:
      throw new Error(`Unknown session subcommand: ${sub ?? '(missing)'}`);
  }
}

function parseToolAuthorizeCommand(args: string[]): CommandSpec {
  const tool = args[0];
  if (!tool) throw new Error('tool-authorize requires <tool>');
  const targetPath = args[1];
  const rawArgs = args[2];
  const params: Record<string, unknown> = { tool };
  if (targetPath) params['target_path'] = targetPath;
  if (rawArgs) params['args'] = parseJson<Record<string, unknown>>(rawArgs, 'jsonArgs');
  return { method: 'tool.authorize', params };
}

function parseContainerLogsFlags(flags: string[]): { follow?: boolean; tail?: number } {
  const result: { follow?: boolean; tail?: number } = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--follow') {
      result.follow = true;
      continue;
    }
    if (flag === '--tail') {
      const value = flags[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('container logs --tail requires a numeric value');
      }
      const tail = Number(value);
      if (!Number.isInteger(tail) || tail < 0) {
        throw new Error('container logs --tail must be a non-negative integer');
      }
      result.tail = tail;
      i += 1;
      continue;
    }
    throw new Error(`Unknown container logs flag: ${flag}`);
  }
  return result;
}

function parseContainerCommand(args: string[]): CommandSpec {
  const sub = args[0];
  switch (sub) {
    case 'create': {
      const template = args[1];
      const rawConfig = args[2];
      if (!template || !rawConfig) {
        throw new Error('container create requires <template> <jsonConfig>');
      }
      return {
        method: 'container.create',
        params: {
          template,
          config: parseJson<Record<string, unknown>>(rawConfig, 'jsonConfig'),
        },
      };
    }
    case 'destroy':
    case 'state':
    case 'pause':
    case 'resume': {
      const id = args[1];
      if (!id) throw new Error(`container ${sub} requires <id>`);
      return { method: `container.${sub}`, params: { id } };
    }
    case 'exec': {
      const id = args[1];
      const rawCommand = args[2];
      if (!id || !rawCommand) {
        throw new Error('container exec requires <id> <jsonArrayCommand> [jsonOpts]');
      }
      const command = parseJson<unknown[]>(rawCommand, 'jsonArrayCommand');
      if (!Array.isArray(command) || !command.every(v => typeof v === 'string')) {
        throw new Error('container exec command must be a JSON array of strings');
      }
      const params: Record<string, unknown> = { id, command };
      if (args[3]) {
        params['opts'] = parseJson<Record<string, unknown>>(args[3], 'jsonOpts');
      }
      return { method: 'container.exec', params };
    }
    case 'logs': {
      const id = args[1];
      if (!id) throw new Error('container logs requires <id>');
      const params: Record<string, unknown> = { id };
      const logFlags = parseContainerLogsFlags(args.slice(2));
      if (typeof logFlags.follow === 'boolean') params['follow'] = logFlags.follow;
      if (typeof logFlags.tail === 'number') params['tail'] = logFlags.tail;
      return { method: 'container.logs', params };
    }
    default:
      throw new Error(`Unknown container subcommand: ${sub ?? '(missing)'}`);
  }
}

export function parseCommand(args: string[]): CommandSpec {
  const command = args[0];
  switch (command) {
    case 'ping':
      return { method: 'test.ping', params: {} };
    case 'rpc': {
      const method = args[1];
      if (!method) throw new Error('rpc requires <method> [jsonParams]');
      const params = args[2]
        ? parseJson<Record<string, unknown>>(args[2], 'jsonParams')
        : {};
      return { method, params };
    }
    case 'session':
      return parseSessionCommand(args.slice(1));
    case 'tool-authorize':
      return parseToolAuthorizeCommand(args.slice(1));
    case 'container':
      return parseContainerCommand(args.slice(1));
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      process.exit(0);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function preflightSocketPath(socketPath: string, warn: (message: string) => void = console.error): void {
  const parentDir = path.dirname(socketPath);
  try {
    const parentStat = fs.statSync(parentDir);
    if ((parentStat.mode & 0o002) !== 0) {
      warn(`[security] Warning: socket parent directory is world-writable: ${parentDir}`);
    }
  } catch {
    // Keep behavior compatible: connect path is still attempted when parent can't be inspected.
  }

  if (!fs.existsSync(socketPath)) {
    throw new Error(`IPC socket not found: ${socketPath}`);
  }

  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error(`IPC path is not a Unix socket: ${socketPath}`);
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  skipPreflight?: boolean;
  warn?: (message: string) => void;
  connect?: (socketPath: string) => net.Socket;
}

export async function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<IpcMessage> {
  if (!options.skipPreflight) {
    preflightSocketPath(socketPath, options.warn);
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const connect = options.connect ?? ((target: string) => net.createConnection(target));
  const id = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const req: IpcMessage = {
    id,
    type: 'request',
    method,
    params,
  };
  return new Promise((resolve, reject) => {
    const protocol = new ProtocolHandler();
    const client = connect(socketPath);
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        client.destroy();
        reject(new Error(`IPC timeout while calling ${method}`));
      });
    }, timeoutMs);

    client.on('connect', () => {
      client.write(ProtocolHandler.encode(req));
    });

    client.on('data', (chunk: Buffer) => {
      for (const msg of protocol.handleData(chunk)) {
        if (msg.id !== id || msg.type !== 'response') continue;
        settle(() => {
          client.end();
          resolve(msg);
        });
      }
    });

    client.on('error', (err) => {
      settle(() => reject(err));
    });

    client.on('close', () => {
      if (!settled) {
        settle(() => reject(new Error(`IPC connection closed before response for ${method}`)));
      }
    });
  });
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { socketPath, args } = parseGlobalArgs(argv);
  const spec = parseCommand(args);
  const response = await request(socketPath, spec.method, spec.params);
  if (response.error) {
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  console.log(JSON.stringify(response.result ?? null, null, 2));
}

function isDirectRun(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isDirectRun()) {
  runCli().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
