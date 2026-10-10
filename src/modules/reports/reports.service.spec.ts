import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRatingRow } from '../../infra/database/schema/participations';
import type { QueuePort } from '../../shared/ports/queue.port';
import type { StoragePort } from '../../shared/ports/storage.port';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import type { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

const ORG_ID = '01990000-0000-7000-8000-0000000000a1';
const USER_ID = '01990000-0000-7000-8000-0000000000b1';
const SESSION_ID = '01990000-0000-7000-8000-0000000000c1';

function makeRatingRow(overrides: Partial<SessionRatingRow> = {}): SessionRatingRow {
  return {
    sessionId: SESSION_ID,
    organizationId: ORG_ID,
    ratedByUserId: USER_ID,
    rating: 4,
    comment: null,
    markedInvalid: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ReportsService.rateSession', () => {
  let repo: { rateSession: ReturnType<typeof vi.fn> };
  let service: ReportsService;
  let req: Request;

  beforeEach(() => {
    repo = { rateSession: vi.fn() };
    service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
    );
    req = {} as Request;
  });

  it('persists the rating and returns the view', async () => {
    repo.rateSession.mockResolvedValue(makeRatingRow({ comment: 'Ótimo feedback' }));

    const view = await service.rateSession(
      ORG_ID,
      USER_ID,
      SESSION_ID,
      { rating: 4, comment: 'Ótimo feedback', markedInvalid: false },
      req,
    );

    expect(repo.rateSession).toHaveBeenCalledWith(ORG_ID, USER_ID, SESSION_ID, {
      rating: 4,
      comment: 'Ótimo feedback',
      markedInvalid: false,
    });
    expect(view).toEqual({
      sessionId: SESSION_ID,
      rating: 4,
      comment: 'Ótimo feedback',
      markedInvalid: false,
      ratedByUserId: USER_ID,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('normalizes an empty or missing comment to null', async () => {
    repo.rateSession.mockResolvedValue(makeRatingRow());

    await service.rateSession(
      ORG_ID,
      USER_ID,
      SESSION_ID,
      { rating: 3, comment: '', markedInvalid: false },
      req,
    );
    await service.rateSession(
      ORG_ID,
      USER_ID,
      SESSION_ID,
      { rating: 3, markedInvalid: false },
      req,
    );

    expect(repo.rateSession.mock.calls[0][3].comment).toBeNull();
    expect(repo.rateSession.mock.calls[1][3].comment).toBeNull();
  });

  it('records an audit entry', async () => {
    repo.rateSession.mockResolvedValue(makeRatingRow({ rating: 2, markedInvalid: true }));

    await service.rateSession(ORG_ID, USER_ID, SESSION_ID, { rating: 2, markedInvalid: true }, req);

    expect(drainAuditDrafts(req)).toEqual([
      expect.objectContaining({
        action: 'session.rated',
        entity: 'session_ratings',
        entityId: SESSION_ID,
        after: { rating: 2, markedInvalid: true },
      }),
    ]);
  });

  it('answers 404 when the session is not in the caller organization', async () => {
    repo.rateSession.mockResolvedValue(null);

    await expect(
      service.rateSession(ORG_ID, USER_ID, SESSION_ID, { rating: 5, markedInvalid: false }, req),
    ).rejects.toBeInstanceOf(AppException);
    expect(drainAuditDrafts(req)).toEqual([]);
  });
});
