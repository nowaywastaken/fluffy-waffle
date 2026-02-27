// native/index.ts
import { createRequire } from 'module';
import type { PeerIdentity } from '../src/kernel/ipc/types.ts';

type PeerCred = { pid: number; uid: number; gid: number };

const require = createRequire(import.meta.url);

let addon: { getPeerCred(fd: number): PeerCred } | null = null;
try {
  addon = require('./build/Release/peer_cred.node');
} catch {
  console.error('FATAL: peer_cred native addon not built. Run: npm run build:native');
}

export function getPeerCred(fd: number): PeerIdentity {
  if (!addon) throw new Error('peer_cred native addon not available');
  return addon.getPeerCred(fd);
}
