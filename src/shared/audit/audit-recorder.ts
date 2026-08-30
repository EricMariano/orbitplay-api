import type { AuditEntryDraft } from './audit-context';

/** The persisted, fully-stamped audit record. */
export interface AuditRecord extends AuditEntryDraft {
  organizationId: string | null;
  actorUserId: string | null;
  ip: string | null;
  requestId: string | null;
}

/** Port for persisting audit records. Implemented by the audit module. */
export interface AuditRecorder {
  record(records: AuditRecord[]): Promise<void>;
}

export const AUDIT_RECORDER = Symbol('AUDIT_RECORDER');
