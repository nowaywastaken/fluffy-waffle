import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHashV1,
  computeHashV2,
  getGenesisHash,
  verifyChain,
} from './chain.ts';
import type { AuditEntry } from './types.ts';

function makeEntry(
  id: number,
  prevHash: string,
  action: string,
  hashV: 1 | 2 = 2,
): AuditEntry {
  const entry: AuditEntry = {
    id,
    timestamp: `2026-02-28T00:00:0${id}.000Z`,
    category: 'tool',
    action,
    actor: 'kernel',
    detail: { id },
    decision: 'allow',
    hash_v: hashV,
    prev_hash: prevHash,
  };
  entry.hash = hashV === 2 ? computeHashV2(entry) : computeHashV1(entry);
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

  it('verifies legacy v1 entries', () => {
    const e1 = makeEntry(1, getGenesisHash(), 'fs.read', 1);
    const e2 = makeEntry(2, e1.hash!, 'fs.write', 1);
    const result = verifyChain([e1, e2]);
    assert.deepEqual(result, { valid: true });
  });

  it('v2 hash is robust when fields include pipe separators', () => {
    const e1 = makeEntry(1, getGenesisHash(), 'fs.read|pipe');
    e1.detail = { nested: { token: 'a|b|c' }, list: ['x|y'] };
    e1.hash = computeHashV2(e1);
    const result = verifyChain([e1]);
    assert.deepEqual(result, { valid: true });
  });

  it('uses all-zero genesis hash', () => {
    assert.equal(getGenesisHash(), '0'.repeat(64));
  });
});
