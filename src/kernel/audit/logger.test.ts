import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuditLogger } from './logger.ts';
import { AuditStore } from './store.ts';

function buildLogger(flushInterval = 500, flushThreshold = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'fluffy-audit-logger-'));
  const dbPath = join(dir, 'audit.db');
  const store = new AuditStore(dbPath);
  const logger = new AuditLogger(store, { flushInterval, flushThreshold });
  return { dbPath, store, logger };
}

describe('audit/logger', () => {
  it('flushes immediately when threshold is reached', () => {
    const { store, logger } = buildLogger(1000, 2);

    logger.log({
      category: 'tool',
      action: 'fs.read',
      actor: 'kernel',
      detail: { file: 'a.ts' },
      decision: 'allow',
    });

    logger.log({
      category: 'tool',
      action: 'fs.write',
      actor: 'kernel',
      detail: { file: 'b.ts' },
      decision: 'allow',
    });

    const rows = store.getEntryRange(1, 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.hash_v, 2);
    assert.equal(rows[1]?.hash_v, 2);
    assert.equal(logger.verifyIntegrity().valid, true);

    logger.close();
  });

  it('flushes on timer interval', async () => {
    const { store, logger } = buildLogger(20, 10);

    logger.log({
      category: 'lifecycle',
      action: 'kernel.start',
      actor: 'kernel',
      detail: {},
      decision: 'allow',
    });

    await sleep(40);

    const rows = store.getEntryRange(1, 10);
    assert.equal(rows.length, 1);

    logger.close();
  });

  it('detects database tampering through hash verification', () => {
    const { dbPath, logger } = buildLogger(1000, 1);

    logger.log({
      category: 'tool',
      action: 'fs.read',
      actor: 'kernel',
      detail: { file: 'safe.ts' },
      decision: 'allow',
    });

    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE audit_log SET detail = '{\"file\":\"tampered.ts\"}' WHERE id = 1");
    db.close();

    const result = logger.verifyIntegrity();
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 1);

    logger.close();
  });

  it('preserves chain integrity under high-frequency buffered writes', () => {
    const { store, logger } = buildLogger(1000, 500);

    for (let i = 0; i < 300; i++) {
      logger.log({
        category: 'tool',
        action: `stress-${i}`,
        actor: 'kernel',
        detail: { i, payload: 'x'.repeat(8) },
        decision: 'allow',
      });
    }
    logger.flush();

    const rows = store.getEntryRange(1, 300);
    assert.equal(rows.length, 300);
    assert.equal(logger.verifyIntegrity(500).valid, true);
    logger.close();
  });
});
