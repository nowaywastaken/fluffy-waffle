import { createHash } from 'node:crypto';
import type { AuditEntry } from './types.ts';

export function getGenesisHash(): string {
  return '0'.repeat(64);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => stableStringify(v === undefined ? null : v));
    return `[${parts.join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
    }
    return `{${parts.join(',')}}`;
  }

  return JSON.stringify(String(value));
}

export function computeHashV1(entry: AuditEntry): string {
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

export function computeHashV2(entry: AuditEntry): string {
  if (entry.id == null) throw new Error('Audit entry id is required to compute hash');
  if (!entry.prev_hash) throw new Error('Audit entry prev_hash is required to compute hash');

  const payload = stableStringify({
    v: 2,
    id: entry.id,
    timestamp: entry.timestamp,
    category: entry.category,
    action: entry.action,
    actor: entry.actor,
    detail: entry.detail,
    decision: entry.decision ?? null,
    prev_hash: entry.prev_hash,
  });

  return createHash('sha256').update(payload).digest('hex');
}

// Backward compatible alias. New writes should use v2.
export function computeHash(entry: AuditEntry): string {
  return computeHashV2(entry);
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

    const expected = entry.hash_v === 2 ? computeHashV2(entry) : computeHashV1(entry);
    if (entry.hash !== expected) {
      return { valid: false, brokenAt: entry.id };
    }

    previousHash = entry.hash;
  }

  return { valid: true };
}
