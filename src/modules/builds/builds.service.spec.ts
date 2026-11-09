import type { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildRow } from '../../infra/database/schema/tests';
import type { StoragePort } from '../../shared/ports/storage.port';
import type { BuildsRepository } from './builds.repository';
import { BuildsService } from './builds.service';
import { signPlayToken } from './web-build';

const STUDIO_ORG = '01990000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '01990000-0000-7000-8000-0000000000a2';
const TEST_ID = '01990000-0000-7000-8000-0000000000c1';
const BUILD_ID = '01990000-0000-7000-8000-0000000000d1';
const OTHER_BUILD_ID = '01990000-0000-7000-8000-0000000000d2';
const USER_ID = '01990000-0000-7000-8000-0000000000e1';
const SECRET = 'test-access-secret';
const WEB_PREFIX = `orgs/${STUDIO_ORG}/tests/${TEST_ID}/builds/${BUILD_ID}/web/`;
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
    findLatestBuild: ReturnType<typeof vi.fn>;
    hasActiveParticipation: ReturnType<typeof vi.fn>;
  };
  let storage: {
    createDownloadUrl: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    getObjectStream: ReturnType<typeof vi.fn>;
  };
  const config = { get: (key: string) => (key === 'jwt.accessSecret' ? SECRET : undefined) };
  let service: BuildsService;

  beforeEach(() => {
    repo = {
      findByIdAnyOrg: vi.fn().mockResolvedValue(makeBuild()),
      findLatestBuild: vi.fn().mockResolvedValue({ build: makeBuild(), steps: [] }),
      hasActiveParticipation: vi.fn().mockResolvedValue(true),
    };
    storage = {
      createDownloadUrl: vi.fn().mockResolvedValue('https://minio.local/get'),
      exists: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue({ sizeBytes: 12 }),
      getObjectStream: vi.fn().mockResolvedValue(Readable.from([Buffer.from('<html></html>')])),
    };
    service = new BuildsService(
      repo as unknown as BuildsRepository,
      storage as unknown as StoragePort,
      config as unknown as ConfigService,
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
  describe('playLinkForTest', () => {
    it('signs a link to index.html for a validated, unpacked web build', async () => {
      repo.findLatestBuild.mockResolvedValue({ build: makeBuild({ platform: 'web' }), steps: [] });

      const link = await service.playLinkForTest(TEST_ID);

      expect(storage.exists).toHaveBeenCalledWith(`${WEB_PREFIX}index.html`);
      expect(link?.path).toMatch(
        new RegExp(`^/builds/${BUILD_ID}/play/\\d+\\.[\\w-]+/index\\.html$`),
      );
      expect(new Date(link!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('is null for builds the player downloads instead', async () => {
      expect(await service.playLinkForTest(TEST_ID)).toBeNull(); // windows

      repo.findLatestBuild.mockResolvedValue({
        build: makeBuild({ platform: 'web', status: 'processing' }),
        steps: [],
      });
      expect(await service.playLinkForTest(TEST_ID)).toBeNull();

      repo.findLatestBuild.mockResolvedValue({ build: makeBuild({ platform: 'web' }), steps: [] });
      storage.exists.mockResolvedValue(false); // validated before web builds were unpacked
      expect(await service.playLinkForTest(TEST_ID)).toBeNull();
    });
  });

  describe('openPlayFile', () => {
    beforeEach(() => {
      repo.findByIdAnyOrg.mockResolvedValue(makeBuild({ platform: 'web' }));
    });

    it('streams the file under the build folder with its content type', async () => {
      const { token } = signPlayToken(SECRET, BUILD_ID);

      const file = await service.openPlayFile(BUILD_ID, token, 'assets/app.js');

      expect(storage.stat).toHaveBeenCalledWith(`${WEB_PREFIX}assets/app.js`);
      expect(file.contentType).toBe('text/javascript; charset=utf-8');
      expect(file.sizeBytes).toBe(12);
    });

    it('serves index.html for a folder path', async () => {
      const { token } = signPlayToken(SECRET, BUILD_ID);

      await service.openPlayFile(BUILD_ID, token, 'levels/');

      expect(storage.stat).toHaveBeenCalledWith(`${WEB_PREFIX}levels/index.html`);
    });

    it.each([
      ['a token signed for another build', () => signPlayToken(SECRET, OTHER_BUILD_ID).token],
      ['an expired token', () => signPlayToken(SECRET, BUILD_ID, Date.now() - 5 * 3600_000).token],
      ['a token signed with another secret', () => signPlayToken('other', BUILD_ID).token],
      ['garbage', () => 'not-a-token'],
    ])('is a 404 for %s, without touching storage', async (_label, token) => {
      await expect(service.openPlayFile(BUILD_ID, token(), 'index.html')).rejects.toMatchObject({
        status: 404,
      });
      expect(storage.stat).not.toHaveBeenCalled();
    });

    it('is a 404 for a path that climbs out of the build folder', async () => {
      const { token } = signPlayToken(SECRET, BUILD_ID);

      await expect(
        service.openPlayFile(BUILD_ID, token, '../validated/game.zip'),
      ).rejects.toMatchObject({ status: 404 });
      expect(storage.stat).not.toHaveBeenCalled();
    });

    it('is a 404 once the build is no longer a validated web build', async () => {
      const { token } = signPlayToken(SECRET, BUILD_ID);
      repo.findByIdAnyOrg.mockResolvedValue(makeBuild({ platform: 'web', status: 'failed' }));

      await expect(service.openPlayFile(BUILD_ID, token, 'index.html')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('is a 404 for a file the build does not have', async () => {
      const { token } = signPlayToken(SECRET, BUILD_ID);
      storage.stat.mockResolvedValue(null);

      await expect(service.openPlayFile(BUILD_ID, token, 'missing.js')).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
