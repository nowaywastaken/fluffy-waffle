import { createHash } from 'node:crypto';
import type { AuditEntry } from './types.ts';

export function getGenesisHash(): string {
  return '0'.repeat(64);
}

export function computeHash(entry: AuditEntry): string {
  if (entry.id == null) throw new Error('Audit entry id is required to compute hash');
  if (!entry.prev_hash) throw new Error('Audit entry prev_hash is required to compute hash');

  const payload = [
    String(entry.id),
    entry.timestamp,
    entry.category,
    entry.action,
    entry.actor,
    JSON.stringify(entry.detail),
    entry.decision ?? '',
    entry.prev_hash,
  ].join('|');

  return createHash('sha256').update(payload).digest('hex');
}

export function verifyChain(entries: AuditEntry[]): { valid: boolean; brokenAt?: number } {
  if (entries.length === 0) return { valid: true };

  let previousHash = getGenesisHash();

  for (const [i, entry] of entries.entries()) {
    if (entry.id == null || !entry.hash || !entry.prev_hash) {
      return { valid: false, brokenAt: entry.id ?? i + 1 };
    }

    if (entry.prev_hash !== previousHash) {
      return { valid: false, brokenAt: entry.id };
    }

    const expected = computeHash(entry);
    if (entry.hash !== expected) {
      return { valid: false, brokenAt: entry.id };
    }

    previousHash = entry.hash;
  }

  return { valid: true };
}
