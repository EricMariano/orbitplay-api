import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogRow } from '../../infra/database/schema/audit-log';
import { AuditQueryService } from './audit-query.service';
import type { AuditRepository } from './audit.repository';

const ORG = '01920000-0000-7000-8000-0000000000a1';

function makeRow(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: '01920000-0000-7000-8000-0000000000e1',
    organizationId: ORG,
    actorUserId: '01920000-0000-7000-8000-0000000000c1',
    action: 'game.created',
    entity: 'games',
    entityId: '01920000-0000-7000-8000-0000000000d1',
    before: null,
    after: { title: 'Nebula Drift' },
    ip: '127.0.0.1',
    requestId: 'req-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AuditQueryService', () => {
  let repo: { listInOrg: ReturnType<typeof vi.fn> };
  let service: AuditQueryService;

  beforeEach(() => {
    repo = { listInOrg: vi.fn() };
    service = new AuditQueryService(repo as unknown as AuditRepository);
  });

  it('scopes the listing to the caller organization (RN-01)', async () => {
    repo.listInOrg.mockResolvedValue({ data: [], nextCursor: null });

    await service.list(ORG, { limit: 20 });

    expect(repo.listInOrg).toHaveBeenCalledWith(ORG, expect.objectContaining({ limit: 20 }));
  });

  it('forwards every filter field to the repository, converting from/to to Date', async () => {
    repo.listInOrg.mockResolvedValue({ data: [], nextCursor: null });
    const fromIso = '2026-01-01T00:00:00.000Z';
    const toIso = '2026-01-31T23:59:59.000Z';

    await service.list(ORG, {
      limit: 10,
      cursor: 'abc',
      actorUserId: 'actor-1',
      action: 'game.created',
      entity: 'games',
      entityId: 'game-1',
      from: fromIso,
      to: toIso,
    });

    expect(repo.listInOrg).toHaveBeenCalledWith(ORG, {
      limit: 10,
      cursor: 'abc',
      actorUserId: 'actor-1',
      action: 'game.created',
      entity: 'games',
      entityId: 'game-1',
      from: new Date(fromIso),
      to: new Date(toIso),
    });
  });

  it('leaves from/to undefined when the query omits them', async () => {
    repo.listInOrg.mockResolvedValue({ data: [], nextCursor: null });

    await service.list(ORG, { limit: 20 });

    expect(repo.listInOrg).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ from: undefined, to: undefined }),
    );
  });

  it('maps rows to the public view with ISO timestamps and passthrough JSON', async () => {
    repo.listInOrg.mockResolvedValue({ data: [makeRow()], nextCursor: 'next' });

    const page = await service.list(ORG, { limit: 20 });

    expect(page.nextCursor).toBe('next');
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: '01920000-0000-7000-8000-0000000000e1',
      organizationId: ORG,
      action: 'game.created',
      entity: 'games',
      after: { title: 'Nebula Drift' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('preserves null actorUserId/organizationId (pre-auth or system events)', async () => {
    repo.listInOrg.mockResolvedValue({
      data: [makeRow({ organizationId: null, actorUserId: null })],
      nextCursor: null,
    });

    const page = await service.list(ORG, { limit: 20 });

    expect(page.data[0].organizationId).toBeNull();
    expect(page.data[0].actorUserId).toBeNull();
  });

  it('falls back to null for a non-object jsonb value in before/after', async () => {
    repo.listInOrg.mockResolvedValue({
      data: [makeRow({ before: ['not', 'an', 'object'] as unknown as null, after: null })],
      nextCursor: null,
    });

    const page = await service.list(ORG, { limit: 20 });

    expect(page.data[0].before).toBeNull();
  });
});
