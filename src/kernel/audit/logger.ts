import { statSync } from 'node:fs';
import { computeHash, getGenesisHash, verifyChain } from './chain.ts';
import { AuditStore } from './store.ts';
import type { AuditCategory, AuditDecision, AuditEntry } from './types.ts';

export interface AuditLoggerOptions {
  flushInterval?: number;
  flushThreshold?: number;
  maxDbSizeBytes?: number;
}

type PendingAuditEntry = {
  category: AuditCategory;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
  decision?: AuditDecision | null;
};

export class AuditLogger {
  private readonly store: AuditStore;
  private readonly flushInterval: number;
  private readonly flushThreshold: number;
  private readonly maxDbSizeBytes: number;

  private readonly timer: NodeJS.Timeout;
  private readonly buffer: PendingAuditEntry[] = [];
  private flushing = false;
  private closed = false;
  private nextId: number;
  private lastHash: string;
  private warnedOnSize = false;

  constructor(store: AuditStore, opts: AuditLoggerOptions = {}) {
    this.store = store;
    this.flushInterval = opts.flushInterval ?? 500;
    this.flushThreshold = opts.flushThreshold ?? 100;
    this.maxDbSizeBytes = opts.maxDbSizeBytes ?? 100 * 1024 * 1024;

    const lastEntry = this.store.getLastEntry();
    this.nextId = (lastEntry?.id ?? 0) + 1;
    this.lastHash = lastEntry?.hash ?? getGenesisHash();

    this.timer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
    this.timer.unref();
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp' | 'prev_hash' | 'hash'>): void {
    if (this.closed) throw new Error('AuditLogger is closed');

    const pending: PendingAuditEntry = {
      category: entry.category,
      action: entry.action,
      actor: entry.actor,
      detail: entry.detail,
    };
    if (entry.decision !== undefined) pending.decision = entry.decision;
    this.buffer.push(pending);

    if (this.buffer.length >= this.flushThreshold) {
      this.flush();
    }
  }

  flush(): void {
    if (this.closed || this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const pending = this.buffer.splice(0, this.buffer.length);
    let attempt = 0;

    while (attempt < 2) {
      attempt += 1;
      try {
        const concreteEntries: AuditEntry[] = [];
        let idCursor = this.nextId;
        let prevHash = this.lastHash;

        for (const item of pending) {
          const concrete: AuditEntry = {
            id: idCursor,
            timestamp: new Date().toISOString(),
            category: item.category,
            action: item.action,
            actor: item.actor,
            detail: item.detail,
            prev_hash: prevHash,
          };
          if (item.decision !== undefined) concrete.decision = item.decision;
          concrete.hash = computeHash(concrete);
          concreteEntries.push(concrete);

          idCursor += 1;
          prevHash = concrete.hash;
        }

        this.store.appendBatch(concreteEntries);
        this.nextId = idCursor;
        this.lastHash = prevHash;

        this.warnOnDbSize();
        this.flushing = false;
        return;
      } catch (err) {
        if (attempt >= 2) {
          this.flushing = false;
          throw err;
        }

        // Another writer may have inserted rows. Refresh and retry once.
        const lastEntry = this.store.getLastEntry();
        this.nextId = (lastEntry?.id ?? 0) + 1;
        this.lastHash = lastEntry?.hash ?? getGenesisHash();
      }
    }

    this.flushing = false;
  }

  verifyIntegrity(lastN = 1000): { valid: boolean; brokenAt?: number } {
    const lastEntry = this.store.getLastEntry();
    if (!lastEntry?.id) return { valid: true };

    const tailSize = Math.max(lastN, 1);
    const fromId = Math.max(1, lastEntry.id - tailSize + 1);
    const entries = this.store.getEntryRange(fromId, lastEntry.id);
    return verifyChain(entries);
  }

  close(): void {
    if (this.closed) return;
    clearInterval(this.timer);
    this.flush();
    this.closed = true;
    this.store.close();
  }

  private warnOnDbSize(): void {
    if (this.warnedOnSize) return;

    try {
      const primaryPath = this.store.getPath();
      const stats = statSync(primaryPath);
      if (stats.size > this.maxDbSizeBytes) {
        this.warnedOnSize = true;
        console.warn(
          `Audit DB exceeded ${this.maxDbSizeBytes} bytes at ${primaryPath}. Consider archiving logs.`,
        );
      }
    } catch {
      // Non-fatal: size warning is best effort.
    }
  }
}
