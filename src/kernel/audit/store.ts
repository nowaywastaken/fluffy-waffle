import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, AuditQueryOptions } from './types.ts';

interface AuditRow {
  id: number;
  timestamp: string;
  category: string;
  action: string;
  actor: string;
  detail: string;
  decision: string | null;
  hash_v: number;
  prev_hash: string;
  hash: string;
}

function mapRow(row: AuditRow): AuditEntry {
  const entry: AuditEntry = {
    id: row.id,
    timestamp: row.timestamp,
    category: row.category as AuditEntry['category'],
    action: row.action,
    actor: row.actor,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    hash_v: row.hash_v === 2 ? 2 : 1,
    prev_hash: row.prev_hash,
    hash: row.hash,
  };
  if (row.decision !== null) entry.decision = row.decision as NonNullable<AuditEntry['decision']>;
  return entry;
}

function assertWritableEntry(entry: AuditEntry): void {
  if (!entry.timestamp) throw new Error('AuditEntry.timestamp is required');
  if (!entry.category) throw new Error('AuditEntry.category is required');
  if (!entry.action) throw new Error('AuditEntry.action is required');
  if (!entry.actor) throw new Error('AuditEntry.actor is required');
  if (!entry.prev_hash) throw new Error('AuditEntry.prev_hash is required');
  if (!entry.hash) throw new Error('AuditEntry.hash is required');
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  const rows = stmt.all() as Array<{ name?: string }>;
  return rows.some(row => row.name === column);
}

export class AuditStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT    NOT NULL,
        category    TEXT    NOT NULL,
        action      TEXT    NOT NULL,
        actor       TEXT    NOT NULL,
        detail      TEXT    NOT NULL,
        decision    TEXT,
        hash_v      INTEGER NOT NULL DEFAULT 1,
        prev_hash   TEXT    NOT NULL,
        hash        TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `);
    this.ensureSchemaUpgrades();
  }

  private ensureSchemaUpgrades(): void {
    if (!hasColumn(this.db, 'audit_log', 'hash_v')) {
      this.db.exec('ALTER TABLE audit_log ADD COLUMN hash_v INTEGER NOT NULL DEFAULT 1;');
    }
  }

  append(entry: AuditEntry): number {
    assertWritableEntry(entry);

    if (entry.id != null) {
      const stmt = this.db.prepare(`
        INSERT INTO audit_log (
          id, timestamp, category, action, actor, detail, decision, hash_v, prev_hash, hash
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      (stmt as any).run(
        entry.id,
        entry.timestamp,
        entry.category,
        entry.action,
        entry.actor,
        JSON.stringify(entry.detail),
        entry.decision ?? null,
        entry.hash_v ?? 1,
        entry.prev_hash,
        entry.hash,
      );
      return entry.id;
    }

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (
        timestamp, category, action, actor, detail, decision, hash_v, prev_hash, hash
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    const result = (stmt as any).run(
      entry.timestamp,
      entry.category,
      entry.action,
      entry.actor,
      JSON.stringify(entry.detail),
      entry.decision ?? null,
      entry.hash_v ?? 1,
      entry.prev_hash,
      entry.hash,
    );

    return Number(result.lastInsertRowid);
  }

  appendBatch(entries: AuditEntry[]): number[] {
    if (entries.length === 0) return [];
    for (const entry of entries) assertWritableEntry(entry);

    const ids: number[] = [];
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const entry of entries) {
        ids.push(this.append(entry));
      }
      this.db.exec('COMMIT;');
      return ids;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  query(opts: AuditQueryOptions = {}): AuditEntry[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.category) {
      clauses.push('category = :category');
      params.category = opts.category;
    }
    if (opts.since) {
      clauses.push('timestamp >= :since');
      params.since = opts.since;
    }
    if (opts.until) {
      clauses.push('timestamp <= :until');
      params.until = opts.until;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const sql = `
      SELECT id, timestamp, category, action, actor, detail, decision, hash_v, prev_hash, hash
      FROM audit_log
      ${where}
      ORDER BY id DESC
      LIMIT :limit OFFSET :offset
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all({ ...params, limit, offset }) as unknown as AuditRow[];
    return rows.map(mapRow);
  }

  getLastEntry(): AuditEntry | null {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, category, action, actor, detail, decision, hash_v, prev_hash, hash
      FROM audit_log
      ORDER BY id DESC
      LIMIT 1
    `);
    const row = stmt.get() as unknown as AuditRow | undefined;
    return row ? mapRow(row) : null;
  }

  getEntryRange(fromId: number, toId: number): AuditEntry[] {
    if (toId < fromId) return [];
    const stmt = this.db.prepare(`
      SELECT id, timestamp, category, action, actor, detail, decision, hash_v, prev_hash, hash
      FROM audit_log
      WHERE id >= :fromId AND id <= :toId
      ORDER BY id ASC
    `);
    const rows = stmt.all({ fromId, toId }) as unknown as AuditRow[];
    return rows.map(mapRow);
  }

  close(): void {
    this.db.close();
  }

  getPath(): string {
    return this.dbPath;
  }
}
