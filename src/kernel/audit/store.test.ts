import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHash, getGenesisHash } from './chain.ts';
import { AuditStore } from './store.ts';
import type { AuditEntry } from './types.ts';

function makeEntry(id: number, prevHash: string, action: string): AuditEntry {
  const entry: AuditEntry = {
    id,
    timestamp: `2026-02-28T00:00:0${id}.000Z`,
    category: 'tool',
    action,
    actor: 'kernel',
    detail: { path: `file-${id}.ts` },
    decision: 'allow',
    prev_hash: prevHash,
  };
  entry.hash = computeHash(entry);
  return entry;
}

describe('audit/store', () => {
  it('appends and queries entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fluffy-audit-store-'));
    const store = new AuditStore(join(dir, 'audit.db'));

    const e1 = makeEntry(1, getGenesisHash(), 'fs.read');
    const e2 = makeEntry(2, e1.hash!, 'fs.write');
    store.append(e1);
    store.append(e2);

    const latest = store.getLastEntry();
    assert.equal(latest?.id, 2);
    assert.equal(latest?.action, 'fs.write');

    const rows = store.query({ category: 'tool', limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 2);
    assert.equal(rows[1].id, 1);

    const range = store.getEntryRange(1, 2);
    assert.equal(range.length, 2);
    assert.equal(range[0].id, 1);
    assert.equal(range[1].id, 2);

    store.close();
  });

  it('appends batch in one call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fluffy-audit-store-'));
    const store = new AuditStore(join(dir, 'audit.db'));

    const e1 = makeEntry(1, getGenesisHash(), 'fs.list');
    const e2 = makeEntry(2, e1.hash!, 'search.grep');

    const ids = store.appendBatch([e1, e2]);
    assert.deepEqual(ids, [1, 2]);

    const range = store.getEntryRange(1, 2);
    assert.equal(range.length, 2);

    store.close();
  });
});
