export type AuditCategory = 'policy' | 'tool' | 'ai' | 'lifecycle' | 'error';

export type AuditDecision = 'allow' | 'deny' | 'require_review';

export interface AuditEntry {
  id?: number;
  timestamp: string;
  category: AuditCategory;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
  decision?: AuditDecision | null;
  prev_hash?: string;
  hash?: string;
}

export interface AuditQueryOptions {
  category?: AuditCategory;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}
