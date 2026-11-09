import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildRow } from '../../infra/database/schema/tests';
import type { StoragePort } from '../../shared/ports/storage.port';
import type { BuildsRepository } from './builds.repository';
import { BuildsService } from './builds.service';

const STUDIO_ORG = '01990000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '01990000-0000-7000-8000-0000000000a2';
const TEST_ID = '01990000-0000-7000-8000-0000000000c1';
const BUILD_ID = '01990000-0000-7000-8000-0000000000d1';
const USER_ID = '01990000-0000-7000-8000-0000000000e1';
const THREAT = 'Ameaça detectada: Win.Test.EICAR_HDB-1';

function makeBuild(overrides: Partial<BuildRow> = {}): BuildRow {
  return {
    id: BUILD_ID,
    organizationId: STUDIO_ORG,
    testId: TEST_ID,
    fileName: 'game.zip',
    version: '1.0.0',
    platform: 'windows',
    sizeBytes: 1024,
    checksum: 'abc',
    storageKey: `orgs/${STUDIO_ORG}/tests/${TEST_ID}/builds/${BUILD_ID}/validated/game.zip`,
    status: 'validated',
    failureReason: null,
    scanEngine: null,
    scanSignatures: null,
    scanFinishedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('BuildsService', () => {
  let repo: {
    findByIdAnyOrg: ReturnType<typeof vi.fn>;
    hasActiveParticipation: ReturnType<typeof vi.fn>;
  };
  let storage: { createDownloadUrl: ReturnType<typeof vi.fn> };
  let service: BuildsService;

  beforeEach(() => {
    repo = {
      findByIdAnyOrg: vi.fn().mockResolvedValue(makeBuild()),
      hasActiveParticipation: vi.fn().mockResolvedValue(true),
    };
    storage = { createDownloadUrl: vi.fn().mockResolvedValue('https://minio.local/get') };
    service = new BuildsService(
      repo as unknown as BuildsRepository,
      storage as unknown as StoragePort,
    );
  });

  describe('checkCompatibility', () => {
    it("never hands another org the build's failure reason (it can name the malware)", async () => {
      repo.findByIdAnyOrg.mockResolvedValue(makeBuild({ status: 'failed', failureReason: THREAT }));

      const report = await service.checkCompatibility(OTHER_ORG, BUILD_ID, { platform: 'windows' });

      expect(report).toEqual({
        compatible: false,
        reasons: ['Build indisponível no momento'],
        supportedPlatforms: ['windows'],
      });
    });

    it('gives the owning studio the real reason', async () => {
      repo.findByIdAnyOrg.mockResolvedValue(makeBuild({ status: 'failed', failureReason: THREAT }));

      const report = await service.checkCompatibility(STUDIO_ORG, BUILD_ID, {
        platform: 'windows',
      });

      expect(report.reasons).toEqual([THREAT]);
    });

    it('stays compatible for any org once validated, with platform mismatches still explained', async () => {
      const ok = await service.checkCompatibility(OTHER_ORG, BUILD_ID, { platform: 'windows' });
      expect(ok).toEqual({ compatible: true, reasons: [], supportedPlatforms: ['windows'] });

      const mismatch = await service.checkCompatibility(OTHER_ORG, BUILD_ID, { platform: 'macos' });
      expect(mismatch.reasons).toEqual(['Build disponível apenas para windows']);
    });
  });

  describe('getDownloadUrl', () => {
    it('409s with a generic message for a player outside the build org', async () => {
      repo.findByIdAnyOrg.mockResolvedValue(makeBuild({ status: 'failed', failureReason: THREAT }));

      const err = await service.getDownloadUrl(USER_ID, OTHER_ORG, BUILD_ID, {}).catch((e) => e);

      expect(err).toMatchObject({ status: 409 });
      expect(JSON.stringify((err as { getResponse(): unknown }).getResponse())).not.toContain(
        'EICAR',
      );
      expect(storage.createDownloadUrl).not.toHaveBeenCalled();
    });

    it('keeps the detailed 409 for a player of the owning org', async () => {
      repo.findByIdAnyOrg.mockResolvedValue(makeBuild({ status: 'failed', failureReason: THREAT }));

      await expect(service.getDownloadUrl(USER_ID, STUDIO_ORG, BUILD_ID, {})).rejects.toMatchObject(
        { status: 409, message: THREAT },
      );
    });

    it('signs the download for the key the row points at (the validated copy)', async () => {
      const result = await service.getDownloadUrl(USER_ID, OTHER_ORG, BUILD_ID, {});

      expect(result).toMatchObject({ needsDownload: true, downloadUrl: 'https://minio.local/get' });
      expect(storage.createDownloadUrl).toHaveBeenCalledWith(makeBuild().storageKey, 900);
    });
  });
});
