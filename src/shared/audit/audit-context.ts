import type { Request } from 'express';

/**
 * A single audit intent declared by a service during a request. The service
 * says WHAT changed (action, entity, before/after); the AuditInterceptor
 * uniformly stamps WHO (author), WHERE FROM (ip) and the requestId, then
 * persists it. Controllers never assemble audit rows by hand.
 */
export interface AuditEntryDraft {
  action: string; // e.g. "game.created"
  entity: string; // e.g. "games"
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

interface RequestWithAudit extends Request {
  auditDrafts?: AuditEntryDraft[];
}

/** Called by services to declare an audit intent for the current request. */
export function recordAudit(req: Request, draft: AuditEntryDraft): void {
  const r = req as RequestWithAudit;
  (r.auditDrafts ??= []).push(draft);
}

export function drainAuditDrafts(req: Request): AuditEntryDraft[] {
  const r = req as RequestWithAudit;
  const drafts = r.auditDrafts ?? [];
  r.auditDrafts = [];
  return drafts;
}
