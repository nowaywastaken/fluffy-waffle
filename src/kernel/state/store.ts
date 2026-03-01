import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionState } from './types.ts';

interface StateRow {
  data: string;
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        id          INTEGER PRIMARY KEY CHECK(id = 1),
        updated_at  TEXT NOT NULL,
        data        TEXT NOT NULL
      );
    `);
  }

  save(state: SessionState): void {
    const stmt = this.db.prepare(`
      INSERT INTO session_state (id, updated_at, data)
      VALUES (1, :updated_at, :data)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        data = excluded.data
    `);

    stmt.run({
      updated_at: new Date().toISOString(),
      data: JSON.stringify(state),
    });
  }

  load(): SessionState | null {
    const stmt = this.db.prepare('SELECT data FROM session_state WHERE id = 1');
    const row = stmt.get() as unknown as StateRow | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as SessionState;
  }

  close(): void {
    this.db.close();
  }
}
