// src/kernel/ipc/dispatcher.ts
import { ContainerManager } from '../container/index.ts';
import type { IpcMessage, RequestContext } from './types.ts';

export type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;

export class Dispatcher {
  private handlers = new Map<string, RequestHandler>();
  private containerManager: ContainerManager | undefined;

  constructor(containerManager?: ContainerManager) {
    this.containerManager = containerManager;
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
    } catch (err: unknown) {
      response.error = {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
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
  }
}
