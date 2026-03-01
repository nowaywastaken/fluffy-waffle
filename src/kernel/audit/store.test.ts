import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHashV1, computeHashV2, getGenesisHash } from './chain.ts';
import { AuditStore } from './store.ts';
import type { AuditEntry } from './types.ts';

function makeEntry(id: number, prevHash: string, action: string, hashV: 1 | 2 = 2): AuditEntry {
  const entry: AuditEntry = {
    id,
    timestamp: `2026-02-28T00:00:0${id}.000Z`,
    category: 'tool',
    action,
    actor: 'kernel',
    detail: { path: `file-${id}.ts` },
    decision: 'allow',
    hash_v: hashV,
    prev_hash: prevHash,
  };
  entry.hash = hashV === 2 ? computeHashV2(entry) : computeHashV1(entry);
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
    assert.equal(latest?.hash_v, 2);

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
    assert.equal(range[0]?.hash_v, 2);
    assert.equal(range[1]?.hash_v, 2);

    store.close();
  });

  it('upgrades legacy schema and defaults existing rows to hash_v=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fluffy-audit-store-legacy-'));
    const dbPath = join(dir, 'audit.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL,
        decision TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
    const e1 = makeEntry(1, getGenesisHash(), 'legacy.v1', 1);
    const stmt = db.prepare(`
      INSERT INTO audit_log (id, timestamp, category, action, actor, detail, decision, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (stmt as any).run(
      e1.id,
      e1.timestamp,
      e1.category,
      e1.action,
      e1.actor,
      JSON.stringify(e1.detail),
      e1.decision ?? null,
      e1.prev_hash,
      e1.hash,
    );
    db.close();

    const store = new AuditStore(dbPath);
    const row = store.getLastEntry();
    assert.equal(row?.id, 1);
    assert.equal(row?.hash_v, 1);
    store.close();
  });
});
