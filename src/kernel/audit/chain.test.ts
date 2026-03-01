import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHash, getGenesisHash, verifyChain } from './chain.ts';
import type { AuditEntry } from './types.ts';

function makeEntry(id: number, prevHash: string, action: string): AuditEntry {
  const entry: AuditEntry = {
    id,
    timestamp: `2026-02-28T00:00:0${id}.000Z`,
    category: 'tool',
    action,
    actor: 'kernel',
    detail: { id },
    decision: 'allow',
    prev_hash: prevHash,
  };
  entry.hash = computeHash(entry);
  return entry;
}

describe('audit/chain', () => {
  it('builds and verifies a valid chain', () => {
    const e1 = makeEntry(1, getGenesisHash(), 'fs.read');
    const e2 = makeEntry(2, e1.hash!, 'fs.write');

    const result = verifyChain([e1, e2]);
    assert.deepEqual(result, { valid: true });
  });

  it('detects tampering in hash chain', () => {
    const e1 = makeEntry(1, getGenesisHash(), 'fs.read');
    const e2 = makeEntry(2, e1.hash!, 'fs.write');
    e2.detail = { id: 999 };

    const result = verifyChain([e1, e2]);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 2);
  });

  it('uses all-zero genesis hash', () => {
    assert.equal(getGenesisHash(), '0'.repeat(64));
  });
});
