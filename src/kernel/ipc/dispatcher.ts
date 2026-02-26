import type { IpcMessage } from './transport.js';
import { PolicyEngine, type SyscallContext } from '../security/policy.js';
import { ContainerManager } from '../container/manager.js';

export type RequestHandler = (params: any, context: RequestContext) => Promise<any>;

export interface RequestContext {
  containerId: string;
  pluginName: string;
  capabilityTags: string[];
}

export class Dispatcher {
  private handlers: Map<string, RequestHandler> = new Map();

  constructor(
    private policy: PolicyEngine,
    private containerManager: ContainerManager
  ) {
    this.registerBuiltinHandlers();
  }

  public registerHandler(method: string, handler: RequestHandler) {
    this.handlers.set(method, handler);
  }

  private registerBuiltinHandlers() {
    // Ping/Pong for health check
    this.registerHandler('test.ping', async (params) => {
      return { pong: true, received: params };
    });

    // Container Management (Protected by Policy)
    this.registerHandler('container.create', async (params) => {
      // In a real scenario, params would be validated against SandboxConfig schema
      // Here we assume params matches SandboxConfig for MVP
      return this.containerManager.createSandbox(params);
    });
  }

  public async dispatch(message: IpcMessage, connectionContext: RequestContext): Promise<IpcMessage> {
    const response: IpcMessage = {
      id: message.id,
      type: 'response',
      // Initialized with no result/error
    } as IpcMessage;

    try {
      if (message.type !== 'request') {
        throw new Error('Only request messages are supported by dispatcher');
      }

      const method = message.method;
      if (!method) {
        throw new Error('Missing method in request');
      }

      const handler = this.handlers.get(method);
      if (!handler) {
        throw new Error(`Method not found: ${method}`);
      }

      // 1. Security Policy Check
      // We need to map RequestContext to Policy's CallerContext
      const caller = {
        containerId: connectionContext.containerId,
        pluginName: connectionContext.pluginName,
        capabilityTags: connectionContext.capabilityTags
      };

      const syscallCtx: SyscallContext = {
        type: method,
        args: (message.params as Record<string, unknown>) || {},
        caller: caller
      };

      const decision = this.policy.evaluate(syscallCtx);
      console.log(`Policy evaluation for ${method}: ${decision}`);

      if (decision === 'deny') {
        throw new Error(`Access Denied: Policy rejected ${method}`);
      }
      if (decision === 'require_review') {
        // TODO: Implement human review flow
        throw new Error(`Review Required: Policy requires approval for ${method}`);
      }

      // 2. Execute Handler
      const result = await handler(message.params, connectionContext);
      response.result = result;

    } catch (err: any) {
      response.error = {
        code: 'INTERNAL_ERROR', 
        message: err.message || 'Unknown error',
        retryable: false
      };
    }

    return response;
  }
}
