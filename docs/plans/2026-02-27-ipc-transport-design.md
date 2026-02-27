# IPC Transport Layer Design

## Overview

The IPC Transport layer provides secure, authenticated communication between the L1 Kernel and L2 sandbox plugins over Unix domain sockets. It is the primary communication channel for tool calls, health checks, and container management.

**Design Approach**: Incremental refactoring of existing code + critical security additions

**Key Decisions**:
1. Protocol unification: Bootstrap health check migrated to IPC frame format
2. Peer identity: Platform detection + reject on failure (zero-trust)
3. Peer identity implementation: native C++ addon (SO_PEERCRED / LOCAL_PEERCRED)
4. Connection timeout: deferred to v2 (sandbox max_duration provides host-side protection)
5. Interface abstraction: lightweight (no full IpcTransport/IpcConnection), YAGNI

## Architecture

### File Structure

```
src/kernel/ipc/
├── types.ts       (~50 LOC)  - interfaces and type definitions (new)
├── peer.ts        (~70 LOC)  - peer identity verification (new)
├── protocol.ts    (~60 LOC)  - ProtocolHandler (moved from transport.ts)
├── transport.ts   (~100 LOC) - IpcServer refactored with real peer identity
└── dispatcher.ts  (~100 LOC) - fixed import path, simplified

native/
├── peer_cred.cc   (~80 LOC)  - getsockopt SO_PEERCRED / LOCAL_PEERCRED
├── binding.gyp    (~20 LOC)  - node-gyp build config
└── index.ts       (~20 LOC)  - TypeScript wrapper
```

**Also modified:**
- `src/bootstrap/index.ts` — health check migrated to IPC frame format

### Request Flow

```
Bootstrap / Plugin
  -> connect(socket)
  -> IpcServer.handleConnection()
      -> getPeerIdentity()  [SO_PEERCRED / LOCAL_PEERCRED]
          -> failure: socket.destroy(), reject connection
          -> success: build RequestContext with real peer
  -> ProtocolHandler.handleData()  [4-byte length prefix + JSON]
  -> Dispatcher.dispatch(msg, ctx)
      -> handler lookup
      -> (Phase 2: policy check)
      -> execute handler
      -> write response frame
```

## Component Details

### 1. Type Definitions (types.ts)

```typescript
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

export interface RequestContext {
  containerId: string;    // derived from peer.pid, mapped by Scheduler later
  pluginName: string;
  capabilityTags: string[];
  peer: PeerIdentity;     // real peer identity, always verified
}
```

### 2. Peer Identity Verification (peer.ts + native addon)

**Zero-trust rule**: cannot verify identity = reject connection immediately.

**Platform support**:
- Linux: `SO_PEERCRED` via `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ...)`
- macOS: `LOCAL_PEERCRED` via `getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, ...)`
- Other: throws `Unsupported platform`

**native addon (native/peer_cred.cc)**:

Node.js stdlib does not expose SO_PEERCRED/LOCAL_PEERCRED. A C++ native addon is required.

```cpp
// Linux
struct ucred cred;
socklen_t len = sizeof(cred);
getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len);
// returns { pid, uid, gid }

// macOS
struct xucred cred;
socklen_t len = sizeof(cred);
getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &cred, &len);
// returns { uid, gid }; peer pid via proc_pidinfo
```

**Startup behavior**: if native addon fails to load, ALL connections are rejected (fast-fail, not silent degradation).

```typescript
// native/index.ts
let addon: { getPeerCred(fd: number): PeerCred } | null = null;
try {
  addon = require('./build/Release/peer_cred.node');
} catch {
  console.error('FATAL: peer_cred native addon not built. Run: npm run build:native');
}

export function getPeerCred(fd: number): PeerCred {
  if (!addon) throw new Error('peer_cred native addon not available');
  return addon.getPeerCred(fd);
}
```

**peer.ts**:

```typescript
export function getPeerIdentity(socket: net.Socket): PeerIdentity {
  const platform = os.platform();
  try {
    const handle = (socket as any)._handle;
    if (!handle || handle.fd < 0) throw new Error('Socket handle not available');
    if (platform === 'linux' || platform === 'darwin') {
      return getPeerCred(handle.fd);
    }
    throw new Error(`Unsupported platform: ${platform}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Peer identity verification failed: ${msg}`);
  }
}
```

### 3. Protocol Handler (protocol.ts)

Moved from transport.ts, no logic changes. Length-prefixed JSON framing:

```
Frame: [4 bytes: payload length uint32 BE] [payload: UTF-8 JSON]
```

```typescript
export class ProtocolHandler {
  private buffer = Buffer.alloc(0);

  handleData(chunk: Buffer): IpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: IpcMessage[] = [];
    while (true) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(payload.toString('utf8')));
      } catch {
        console.error('IPC: malformed frame, dropping');
      }
    }
    return messages;
  }

  static encode(message: IpcMessage): Buffer {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }
}
```

### 4. IpcServer (transport.ts)

Key changes from existing code:
- `handleConnection()` calls `getPeerIdentity()` immediately, destroys socket on failure
- `chmod 600` instead of `700` (socket file: owner read/write only)
- `MessageHandler` callback replaces tight coupling to `Dispatcher`
- Real `RequestContext` with `peer` field

```typescript
export type MessageHandler = (
  msg: IpcMessage,
  ctx: RequestContext,
  reply: (response: IpcMessage) => void,
) => Promise<void>;

export class IpcServer {
  private server: net.Server;
  private connections = new Set<net.Socket>();
  private handler?: MessageHandler;

  constructor(private readonly socketPath: string) {
    this.server = net.createServer(sock => this.handleConnection(sock));
  }

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  async listen(): Promise<void> {
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, '600');
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const conn of this.connections) conn.destroy();
    this.connections.clear();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    // Zero-trust: verify peer before accepting any data
    let peer: PeerIdentity;
    try {
      peer = getPeerIdentity(socket);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`IPC: rejected connection — ${msg}`);
      socket.destroy();
      return;
    }

    this.connections.add(socket);
    const protocol = new ProtocolHandler();
    const ctx: RequestContext = {
      containerId: `container-${peer.pid}`,
      pluginName: 'unknown',
      capabilityTags: [],
      peer,
    };
    const reply = (response: IpcMessage) => {
      socket.write(ProtocolHandler.encode(response));
    };

    socket.on('data', async chunk => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const msg of protocol.handleData(buf)) {
        await this.handler?.(msg, ctx, reply);
      }
    });
    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', err => console.error('IPC socket error:', err.message));
  }
}
```

### 5. Dispatcher (dispatcher.ts)

Key changes:
- Fixed import: `'../container/manager.js'` -> `'../container/index.ts'`
- Removed `PolicyEngine` dependency (deferred to Phase 2)
- Simplified `RequestContext` usage to include `peer`

```typescript
import type { IpcMessage, RequestContext } from './types.ts';
import { ContainerManager } from '../container/index.ts';

export type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;

export class Dispatcher {
  private handlers = new Map<string, RequestHandler>();

  constructor(private readonly containerManager: ContainerManager) {
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
    // Bootstrap health check
    this.register('test.ping', async () => ({ pong: true }));

    // Container management (Phase 2: add policy check)
    this.register('container.create', async (params) => {
      const p = params as { template: string; config: Record<string, unknown> };
      return this.containerManager.createSandbox(p.template, p.config as any);
    });
  }
}
```

### 6. Bootstrap Health Check Migration (bootstrap/index.ts)

Replace bare JSON ping/pong with IPC frame format:

```typescript
// Build a proper IPC request frame
function buildPingFrame(): Buffer {
  const msg: IpcMessage = {
    id: 'bootstrap-ping-1',
    type: 'request',
    method: 'test.ping',
    params: {},
  };
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

// Parse IPC response frame and check pong
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
```

## Security Properties

| Property | Implementation |
|---|---|
| Peer identity mandatory | `getPeerIdentity()` called before any data processed |
| Reject on failure | `socket.destroy()` if peer verification fails |
| Addon unavailable = fail closed | all connections rejected if native addon missing |
| Socket file permissions | `chmod 600` (owner read/write only) |
| No platform fallback | unsupported platform throws, connection rejected |
| Protocol consistency | single frame format for all IPC including health check |

## Testing Strategy

### Unit Tests
- `ProtocolHandler`: encode/decode round-trip, partial frames, multi-message buffer
- `Dispatcher`: method routing, missing method error, builtin handlers
- Bootstrap ping frame: encode + parse round-trip

### Integration Tests (requires running Kernel)
- IpcServer listen + client connect + ping/pong
- Connection rejection on peer verification failure (mock)

### Manual Tests
- Bootstrap -> Kernel health check end-to-end
- Invalid frame handling (truncated, malformed JSON)

## Future Enhancements (Out of Scope v1)

- Connection idle timeout (currently deferred, sandbox max_duration provides protection)
- Request-level timeout with in-flight tracking
- Event type messages (one-way notifications from Kernel to plugins)
- Connection pool for high-throughput tool calls
- Capability token binding to (container_id, peer_pid) pair

## References

- Architecture Design: `docs/plans/2026-02-26-architecture-design.md`
- IPC Transport Abstraction: lines 256-284
- IPC Wire Protocol: lines 285-311
- Bootstrap health check: `src/bootstrap/index.ts:202-246`
