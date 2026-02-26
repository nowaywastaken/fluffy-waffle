import * as net from 'net';
import * as fs from 'fs';
import { Dispatcher, type RequestContext } from './dispatcher.js';

/**
 * IPC Transport Abstraction
 * Handles Unix Domain Socket communication and peer identity verification.
 */

export interface PeerIdentity {
  pid: number;
  uid: number;
  gid: number;
}

export interface IpcMessage {
  id: string;
  type: 'request' | 'response' | 'event';
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export class IpcServer {
  private server: net.Server;
  private connections: Set<net.Socket> = new Set();
  private dispatcher?: Dispatcher;

  constructor(private socketPath: string) {
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  public setDispatcher(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
  }

  public async listen(): Promise<void> {
    // Cleanup existing socket
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, () => {
        // Ensure restricted permissions on socket file
        fs.chmodSync(this.socketPath, '700'); 
        resolve();
      });

      this.server.on('error', (err) => reject(err));
    });
  }

  public async close(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();
    
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleConnection(socket: net.Socket) {
    this.connections.add(socket);
    const handler = new ProtocolHandler();

    // Context for this connection (In MVP, we use placeholders)
    // Real impl: retrieve peer creds
    const context: RequestContext = {
      containerId: 'unknown',
      pluginName: 'unknown-plugin',
      capabilityTags: ['core_plugin'] // Allow everything for MVP test
    };

    socket.on('data', async (chunk) => {
      if (typeof chunk === 'string') {
        // Should not happen with socket unless setEncoding is called
        chunk = Buffer.from(chunk);
      }
      
      const messages = handler.handleData(chunk);
      for (const msg of messages) {
        if (this.dispatcher) {
          const response = await this.dispatcher.dispatch(msg, context);
          const packet = ProtocolHandler.encode(response);
          socket.write(packet);
        }
      }
    });

    socket.on('close', () => {
      this.connections.delete(socket);
    });

    socket.on('error', (err) => {
      console.error('IPC Connection error:', err);
    });
  }
}

// Helper to implement the framing protocol
export class ProtocolHandler {
  private buffer: Buffer = Buffer.alloc(0);

  public handleData(chunk: Buffer): IpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: IpcMessage[] = [];

    while (true) {
      if (this.buffer.length < 4) break; // Not enough data for length header

      const length = this.buffer.readUInt32BE(0);
      
      if (this.buffer.length < 4 + length) break; // Not enough data for full payload

      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      try {
        const json = JSON.parse(payload.toString('utf8'));
        messages.push(json);
      } catch (e) {
        console.error('IPC Parse Error:', e);
        // In case of error, we might drop this message or close connection
      }
    }

    return messages;
  }

  public static encode(message: IpcMessage): Buffer {
    const json = JSON.stringify(message);
    const payload = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }
}
