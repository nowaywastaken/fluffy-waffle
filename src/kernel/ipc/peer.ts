// src/kernel/ipc/peer.ts
import type * as net from 'net';
import { getPeerCred } from '../../../native/index.ts';
import type { PeerIdentity } from './types.ts';

export function getPeerIdentity(socket: net.Socket): PeerIdentity {
  try {
    const handle = (socket as any)._handle;
    if (!handle || handle.fd < 0) throw new Error('Socket handle not available');
    return getPeerCred(handle.fd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Peer identity verification failed: ${msg}`);
  }
}
