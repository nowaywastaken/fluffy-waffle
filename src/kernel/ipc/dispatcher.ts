// src/kernel/ipc/dispatcher.ts
import { ContainerManager } from '../container/index.ts';
import type { AuditDecision } from '../audit/types.ts';
import type { PolicyEngine } from '../security/engine.ts';
import type {
  CapabilityTokenClaim,
  PolicyDecision,
  SyscallContext,
} from '../security/types.ts';
import type { IssueParams, TokenIssuer } from '../security/token.ts';
import type { TddStateMachine } from '../state/machine.ts';
import type { SessionMode, SessionState, ToolGateQuery, ToolName } from '../state/types.ts';
import type { IpcMessage, RequestContext } from './types.ts';

export type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;

interface DispatcherDeps {
  policyEngine?: PolicyEngine;
  tokenIssuer?: TokenIssuer;
  stateMachine?: TddStateMachine;
  persistState?: (state: SessionState) => void;
  audit?: {
    log(entry: {
      category: 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error';
      action: string;
      actor: string;
      detail: Record<string, unknown>;
      decision?: AuditDecision | null;
    }): void;
    verifyIntegrity(lastN?: number): { valid: boolean; brokenAt?: number };
  };
}

const VALID_TOOLS = new Set<ToolName>([
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.exists',
  'search.grep',
  'search.glob',
  'test.run',
  'shell.exec',
]);

const HIGH_RISK_TOOLS = new Set<ToolName>(['fs.write', 'shell.exec']);

export class Dispatcher {
  private handlers = new Map<string, RequestHandler>();
  private containerManager: ContainerManager | undefined;
  private policyEngine: PolicyEngine | undefined;
  private tokenIssuer: TokenIssuer | undefined;
  private stateMachine: TddStateMachine | undefined;
  private persistState: ((state: SessionState) => void) | undefined;
  private audit:
    | {
      log(entry: {
        category: 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error';
        action: string;
        actor: string;
        detail: Record<string, unknown>;
        decision?: AuditDecision | null;
      }): void;
      verifyIntegrity(lastN?: number): { valid: boolean; brokenAt?: number };
    }
    | undefined;

  constructor(containerManager?: ContainerManager, deps: DispatcherDeps = {}) {
    this.containerManager = containerManager;
    this.policyEngine = deps.policyEngine;
    this.tokenIssuer = deps.tokenIssuer;
    this.stateMachine = deps.stateMachine;
    this.persistState = deps.persistState;
    this.audit = deps.audit;
    this.registerBuiltins();
  }

  register(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(msg: IpcMessage, ctx: RequestContext): Promise<IpcMessage> {
    const response: IpcMessage = { id: msg.id, type: 'response' };
    try {
      if (msg.type !== 'request') throw new Error('Only requests supported');
      if (!msg.method) throw new Error('Missing method');
      const handler = this.handlers.get(msg.method);
      if (!handler) throw new Error(`Method not found: ${msg.method}`);
      response.result = await handler(msg.params, ctx);
      this.auditLog({
        category: 'tool',
        action: `ipc.${msg.method}`,
        actor: ctx.pluginName,
        detail: {
          msg_id: msg.id,
          container_id: ctx.containerId,
          peer_pid: ctx.peer.pid,
        },
        decision: 'allow',
      });
    } catch (err: unknown) {
      response.error = {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
      this.auditLog({
        category: 'error',
        action: `ipc.${msg.method ?? 'unknown'}`,
        actor: ctx.pluginName,
        detail: {
          msg_id: msg.id,
          container_id: ctx.containerId,
          peer_pid: ctx.peer.pid,
          error: response.error.message,
        },
        decision: 'deny',
      });
    }
    return response;
  }

  private registerBuiltins(): void {
    this.register('test.ping', async () => ({ pong: true }));

    this.register('container.create', async (params) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = params as { template: string; config: Record<string, unknown> };
      return this.containerManager.createSandbox(p.template, p.config as any);
    });

    this.register('container.destroy', async (params) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = this.requireObject(params);
      if (typeof p['id'] !== 'string') throw new Error('container.destroy requires string param "id"');
      await this.containerManager.destroySandbox(p['id']);
      return { ok: true };
    });

    this.register('container.state', async (params) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = this.requireObject(params);
      if (typeof p['id'] !== 'string') throw new Error('container.state requires string param "id"');
      return { id: p['id'], state: this.containerManager.getState(p['id']) };
    });

    this.register('container.pause', async (params) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = this.requireObject(params);
      if (typeof p['id'] !== 'string') throw new Error('container.pause requires string param "id"');
      await this.containerManager.pauseSandbox(p['id']);
      return { ok: true };
    });

    this.register('container.resume', async (params) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = this.requireObject(params);
      if (typeof p['id'] !== 'string') throw new Error('container.resume requires string param "id"');
      await this.containerManager.resumeSandbox(p['id']);
      return { ok: true };
    });

    const runHandler = async (params: unknown) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = this.requireObject(params);
      if (typeof p['id'] !== 'string') throw new Error('container.exec requires string param "id"');
      if (!Array.isArray(p['command']) || !p['command'].every(v => typeof v === 'string')) {
        throw new Error('container.exec requires string[] param "command"');
      }
      const opts = this.objectOrEmpty(p['opts']);
      const timeout = typeof opts['timeout'] === 'number' ? opts['timeout'] : undefined;
      const stdin = typeof opts['stdin'] === 'string' ? opts['stdin'] : undefined;
      const runOpts: { timeout?: number; stdin?: string } = {};
      if (typeof timeout === 'number') runOpts.timeout = timeout;
      if (typeof stdin === 'string') runOpts.stdin = stdin;
      return this.containerManager.runInSandbox(p['id'], p['command'] as string[], runOpts);
    };
    this.register('container.exec', runHandler);
    this.register('container.run', runHandler);

    this.register('container.logs', async (params) => {
      if (!this.containerManager) throw new Error('ContainerManager not available');
      const p = this.requireObject(params);
      if (typeof p['id'] !== 'string') throw new Error('container.logs requires string param "id"');
      const follow = typeof p['follow'] === 'boolean' ? p['follow'] : undefined;
      const tail = typeof p['tail'] === 'number' ? p['tail'] : undefined;
      const logOpts: { follow?: boolean; tail?: number } = {};
      if (typeof follow === 'boolean') logOpts.follow = follow;
      if (typeof tail === 'number') logOpts.tail = tail;
      const lines = await this.containerManager.getLogs(p['id'], logOpts);
      return { lines };
    });

    this.register('session.get', async () => {
      if (!this.stateMachine) return null;
      return this.stateMachine.getState();
    });

    this.register('session.submit_task', async () => {
      const machine = this.requireStateMachine();
      machine.submitTask();
      return this.persistAndGetState();
    });
    this.register('session.submitTask', async () => {
      const machine = this.requireStateMachine();
      machine.submitTask();
      return this.persistAndGetState();
    });

    this.register('session.complete_planning', async () => {
      const machine = this.requireStateMachine();
      machine.completePlanning();
      return this.persistAndGetState();
    });
    this.register('session.completePlanning', async () => {
      const machine = this.requireStateMachine();
      machine.completePlanning();
      return this.persistAndGetState();
    });

    this.register('session.complete_test_writing', async () => {
      const machine = this.requireStateMachine();
      machine.completeTestWriting();
      return this.persistAndGetState();
    });
    this.register('session.completeTestWriting', async () => {
      const machine = this.requireStateMachine();
      machine.completeTestWriting();
      return this.persistAndGetState();
    });

    this.register('session.register_test_file', async (params) => {
      const machine = this.requireStateMachine();
      const p = this.requireObject(params);
      if (typeof p['path'] !== 'string') {
        throw new Error('session.register_test_file requires string param "path"');
      }
      machine.registerTestFile(p['path']);
      return this.persistAndGetState();
    });
    this.register('session.registerTestFile', async (params) => {
      const machine = this.requireStateMachine();
      const p = this.requireObject(params);
      if (typeof p['path'] !== 'string') {
        throw new Error('session.registerTestFile requires string param "path"');
      }
      machine.registerTestFile(p['path']);
      return this.persistAndGetState();
    });

    this.register('session.report_test_result', async (params) => {
      const machine = this.requireStateMachine();
      const p = this.requireObject(params);
      if (typeof p['passed'] !== 'boolean') {
        throw new Error('session.report_test_result requires boolean param "passed"');
      }
      machine.reportTestResult(p['passed']);
      return this.persistAndGetState();
    });
    this.register('session.reportTestResult', async (params) => {
      const machine = this.requireStateMachine();
      const p = this.requireObject(params);
      if (typeof p['passed'] !== 'boolean') {
        throw new Error('session.reportTestResult requires boolean param "passed"');
      }
      machine.reportTestResult(p['passed']);
      return this.persistAndGetState();
    });

    this.register('session.complete_coding', async () => {
      const machine = this.requireStateMachine();
      machine.completeCoding();
      return this.persistAndGetState();
    });
    this.register('session.completeCoding', async () => {
      const machine = this.requireStateMachine();
      machine.completeCoding();
      return this.persistAndGetState();
    });

    this.register('session.set_mode', async (params) => {
      const machine = this.requireStateMachine();
      const p = this.requireObject(params);
      const mode = p['mode'];
      if (mode !== 'strict' && mode !== 'explore' && mode !== 'debug') {
        throw new Error('session.set_mode requires mode: strict|explore|debug');
      }
      machine.setMode(mode as SessionMode);
      return this.persistAndGetState();
    });
    this.register('session.setMode', async (params) => {
      const machine = this.requireStateMachine();
      const p = this.requireObject(params);
      const mode = p['mode'];
      if (mode !== 'strict' && mode !== 'explore' && mode !== 'debug') {
        throw new Error('session.setMode requires mode: strict|explore|debug');
      }
      machine.setMode(mode as SessionMode);
      return this.persistAndGetState();
    });

    this.register('session.reset', async () => {
      const machine = this.requireStateMachine();
      machine.reset();
      return this.persistAndGetState();
    });

    this.register('policy.load_yaml', async (params) => {
      if (!this.policyEngine) throw new Error('PolicyEngine not available');
      const p = this.requireObject(params);
      if (typeof p['path'] !== 'string') throw new Error('policy.load_yaml requires string param "path"');
      this.policyEngine.loadYamlRules(p['path']);
      return { ok: true, path: p['path'] };
    });

    this.register('policy.evaluate', async (params, ctx) => {
      if (!this.policyEngine) throw new Error('PolicyEngine not available');
      const p = this.requireObject(params);
      if (typeof p['type'] !== 'string') throw new Error('policy.evaluate requires string param "type"');
      const args = this.objectOrEmpty(p['args']);
      const syscallCtx = this.buildSyscallContext(
        p['type'],
        ctx,
        args,
        this.optionalToken(p['token']),
      );
      const decision = await this.policyEngine.evaluate(syscallCtx);
      return { decision };
    });

    this.register('token.issue', async (params, ctx) => {
      if (!this.tokenIssuer) throw new Error('TokenIssuer not available');
      const p = this.requireObject(params);
      if (typeof p['syscall'] !== 'string') throw new Error('token.issue requires string param "syscall"');

      const issueParams: IssueParams = {
        containerId: typeof p['containerId'] === 'string' ? p['containerId'] : ctx.containerId,
        peerPid: typeof p['peerPid'] === 'number' ? p['peerPid'] : ctx.peer.pid,
        syscall: p['syscall'],
      };
      if (Array.isArray(p['pathGlob'])) {
        issueParams.pathGlob = p['pathGlob'].filter((x): x is string => typeof x === 'string');
      }
      if (typeof p['maxOps'] === 'number') issueParams.maxOps = p['maxOps'];
      if (typeof p['ttlMs'] === 'number') issueParams.ttlMs = p['ttlMs'];

      return this.tokenIssuer.issue(issueParams);
    });

    this.register('token.revoke', async (params) => {
      if (!this.tokenIssuer) throw new Error('TokenIssuer not available');
      const p = this.requireObject(params);
      if (typeof p['tokenId'] !== 'string') throw new Error('token.revoke requires string param "tokenId"');
      this.tokenIssuer.revoke(p['tokenId']);
      return { ok: true };
    });

    this.register('tool.authorize', async (params, ctx) => {
      const p = this.requireObject(params);
      const tool = p['tool'];
      if (!this.isToolName(tool)) throw new Error('tool.authorize requires a valid "tool" value');

      const targetPath = typeof p['target_path'] === 'string' ? p['target_path'] : undefined;
      const toolGateQuery: ToolGateQuery = { tool };
      if (targetPath) toolGateQuery.target_path = targetPath;

      if (this.stateMachine) {
        const gate = this.stateMachine.isToolAllowed(toolGateQuery);
        if (!gate.allowed) {
          return {
            allowed: false,
            layer: 'state',
            decision: 'deny',
            reason: gate.reason ?? 'Blocked by TDD state machine',
          };
        }
      }

      if (!HIGH_RISK_TOOLS.has(tool)) {
        return {
          allowed: true,
          layer: this.stateMachine ? 'state' : 'none',
          decision: 'allow',
        };
      }

      if (!this.policyEngine) {
        return {
          allowed: false,
          layer: 'policy',
          decision: 'deny',
          reason: 'Policy engine not available for high-risk tool',
        };
      }

      const syscallType = this.mapToolToSyscall(tool);
      const args = this.objectOrEmpty(p['args']);
      if (targetPath) args.path = targetPath;
      const syscallCtx = this.buildSyscallContext(
        syscallType,
        ctx,
        args,
        this.optionalToken(p['token']),
      );
      const decision = await this.policyEngine.evaluate(syscallCtx);

      if (decision === 'allow') {
        return { allowed: true, layer: 'policy', decision };
      }
      if (decision === 'require_review') {
        return {
          allowed: false,
          layer: 'policy',
          decision,
          reason: 'Operation requires human review',
        };
      }

      return {
        allowed: false,
        layer: 'policy',
        decision: 'deny',
        reason: decision === 'pass' ? 'Policy evaluation did not allow operation' : 'Denied by policy',
      };
    });

    this.register('audit.verify', async (params) => {
      if (!this.audit) throw new Error('Audit logger not available');
      const p = this.objectOrEmpty(params);
      const lastN = typeof p['lastN'] === 'number' ? p['lastN'] : 1000;
      return this.audit.verifyIntegrity(lastN);
    });
  }

  private requireObject(params: unknown): Record<string, unknown> {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new Error('params must be an object');
    }
    return params as Record<string, unknown>;
  }

  private objectOrEmpty(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private optionalToken(value: unknown): CapabilityTokenClaim | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as CapabilityTokenClaim;
  }

  private persistAndGetState(): SessionState {
    const machine = this.requireStateMachine();
    const state = machine.getState();
    this.persistState?.(state);
    return state;
  }

  private requireStateMachine(): TddStateMachine {
    if (!this.stateMachine) throw new Error('State machine not available');
    return this.stateMachine;
  }

  private buildSyscallContext(
    type: string,
    ctx: RequestContext,
    args: Record<string, unknown>,
    token?: CapabilityTokenClaim,
  ): SyscallContext {
    const syscallCtx: SyscallContext = {
      type,
      args,
      caller: {
        containerId: ctx.containerId,
        pluginName: ctx.pluginName,
        capabilityTags: ctx.capabilityTags,
        peer: ctx.peer,
      },
    };
    if (token) syscallCtx.token = token;
    return syscallCtx;
  }

  private isToolName(value: unknown): value is ToolName {
    return typeof value === 'string' && VALID_TOOLS.has(value as ToolName);
  }

  private mapToolToSyscall(tool: ToolName): string {
    switch (tool) {
      case 'fs.write':
        return 'fs.write';
      case 'shell.exec':
        return 'shell.exec';
      case 'fs.read':
      case 'fs.list':
      case 'fs.exists':
      case 'search.grep':
      case 'search.glob':
      case 'test.run':
        return tool;
      default:
        return `tool.${tool}`;
    }
  }

  private auditLog(entry: {
    category: 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error';
    action: string;
    actor: string;
    detail: Record<string, unknown>;
    decision?: AuditDecision | null;
  }): void {
    if (!this.audit) return;
    try {
      this.audit.log(entry);
    } catch {
      // audit logging must not break request handling
    }
  }
}
