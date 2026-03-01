// src/kernel/security/token.ts
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import type { CapabilityTokenClaim, SyscallContext } from './types.ts';

export interface IssueParams {
  containerId: string;
  peerPid: number;
  syscall: string;
  pathGlob?: string[];
  maxOps?: number;   // default 1
  ttlMs?: number;    // default 30_000
}

interface TokenRecord {
  ops: number;
  revoked: boolean;
}

export class TokenIssuer {
  private readonly secret: Buffer;
  private store = new Map<string, TokenRecord>();
  private nonce = 0;

  constructor() {
    this.secret = crypto.randomBytes(32);
  }

  issue(params: IssueParams): CapabilityTokenClaim {
    const partial: Omit<CapabilityTokenClaim, 'signature'> = {
      tokenId: randomUUID(),
      containerId: params.containerId,
      peerPid: params.peerPid,
      syscall: params.syscall,
      maxOps: params.maxOps ?? 1,
      expiresAt: Date.now() + (params.ttlMs ?? 30_000),
      nonce: ++this.nonce,
    };
    if (params.pathGlob) {
      partial.pathGlob = params.pathGlob;
    }
    const signature = this.sign(partial);
    this.store.set(partial.tokenId, { ops: 0, revoked: false });
    return { ...partial, signature };
  }

  validate(claim: CapabilityTokenClaim, ctx: SyscallContext, now: number): boolean {
    const { signature, ...payload } = claim;
    if (this.sign(payload) !== signature) return false;
    if (claim.expiresAt <= now) return false;

    const record = this.store.get(claim.tokenId);
    if (!record || record.revoked) return false;
    if (record.ops >= claim.maxOps) return false;

    if (claim.containerId !== ctx.caller.containerId) return false;
    if (claim.peerPid !== ctx.caller.peer.pid) return false;
    if (claim.syscall !== ctx.type) return false;

    if (claim.pathGlob && claim.pathGlob.length > 0) {
      const path = typeof ctx.args['path'] === 'string' ? ctx.args['path'] : null;
      if (!path) return false;
      if (!picomatch(claim.pathGlob)(path)) return false;
    }

    record.ops++;
    return true;
  }

  revoke(tokenId: string): void {
    const record = this.store.get(tokenId);
    if (record) record.revoked = true;
  }

  private sign(payload: Omit<CapabilityTokenClaim, 'signature'>): string {
    const keys = (Object.keys(payload) as Array<keyof typeof payload>).sort();
    const sorted: Record<string, unknown> = {};
    for (const k of keys) sorted[k] = payload[k];
    return crypto.createHmac('sha256', this.secret)
      .update(JSON.stringify(sorted))
      .digest('hex');
  }
}
