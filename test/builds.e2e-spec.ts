import type { INestApplication } from '@nestjs/common';
import { Worker } from 'bullmq';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { MAIN_QUEUE } from '../src/infra/queue/queue.constants';
import { closeWorkerDeps, createWorkerDeps } from '../src/workers/deps';
import { handleJob } from '../src/workers/handle-job';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

const RIVAL = {
  userId: '01996000-0000-7000-8000-0000000000e1',
  orgId: '01996000-0000-7000-8000-0000000000f1',
  membershipId: '01996000-0000-7000-8000-0000000000e9',
  email: 'rival-builds@rival.dev',
};

const BUILD_BYTES = Buffer.from('fake-game-build-bytes');

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

// GAME_IDS.two on purpose: games.e2e-spec asserts playersTotal === 0 for
// GAME_IDS.one, and the participations these tests insert would count
// against it whenever this file happens to run first (see media.e2e-spec).
async function createDraftTest(app: INestApplication, token: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/games/${GAME_IDS.two}/tests`)
    .set('Authorization', `Bearer ${token}`)
    .send({ testModelKey: 'free_exploration' });
  return res.body.id as string;
}

async function uploadAndConfirmBuild(
  app: INestApplication,
  token: string,
  testId: string,
  platform: string,
  version: string,
): Promise<void> {
  const uploadUrl = await request(app.getHttpServer())
    .post(`/tests/${testId}/build/upload-url`)
    .set('Authorization', `Bearer ${token}`)
    .send({ fileName: 'game.zip', contentType: 'application/zip', sizeBytes: BUILD_BYTES.length, platform });
  await fetch(uploadUrl.body.uploadUrl as string, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: BUILD_BYTES,
  });
  const confirm = await request(app.getHttpServer())
    .post(`/tests/${testId}/build`)
    .set('Authorization', `Bearer ${token}`)
    .send({ storageKey: uploadUrl.body.storageKey, platform, version });
  expect(confirm.status).toBe(202);
}

async function waitForBuildId(app: INestApplication, token: string, testId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer())
      .get(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${token}`);
    if (res.status === 200 && (res.body.status === 'validated' || res.body.status === 'failed')) {
      return res.body.id as string;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timeout waiting for build validation');
}

describe('Builds — M6 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let worker: Worker;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDeps>>;
  let studioToken: string;
  let playerToken: string;
  let playerId: string;
  let rivalToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rival Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Rival Builds Studio', 'rival-builds-studio', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    workerDeps = await createWorkerDeps();
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    worker = new Worker(MAIN_QUEUE, (job) => handleJob(job, workerDeps), {
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        maxRetriesPerRequest: null,
      },
    });
    await worker.waitUntilReady();

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${playerToken}`);
    playerId = me.body.id as string;
  });

  afterAll(async () => {
    await worker.close();
    await closeWorkerDeps(workerDeps);
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('GET /builds/:id is studio-only and org-scoped', async () => {
    const testId = await createDraftTest(app, studioToken);
    await uploadAndConfirmBuild(app, studioToken, testId, 'windows', '1.0.0');
    const buildId = await waitForBuildId(app, studioToken, testId);

    const asOwnerStudio = await request(app.getHttpServer())
      .get(`/builds/${buildId}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(asOwnerStudio.status).toBe(200);
    expect(asOwnerStudio.body).toMatchObject({
      id: buildId,
      testId,
      status: 'validated',
      platform: 'windows',
      version: '1.0.0',
    });
    expect(asOwnerStudio.body.validationSteps).toHaveLength(3);

    const asRival = await request(app.getHttpServer())
      .get(`/builds/${buildId}`)
      .set('Authorization', `Bearer ${rivalToken}`);
    expect(asRival.status).toBe(404);

    const asPlayer = await request(app.getHttpServer())
      .get(`/builds/${buildId}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(asPlayer.status).toBe(403);

    const notFound = await request(app.getHttpServer())
      .get(`/builds/${uuidv7()}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(notFound.status).toBe(404);
  });

  it('checks compatibility for any authenticated role, cross-org, without erroring on mismatch', async () => {
    const testId = await createDraftTest(app, studioToken);
    await uploadAndConfirmBuild(app, studioToken, testId, 'windows', '1.0.0');
    const buildId = await waitForBuildId(app, studioToken, testId);

    const matching = await request(app.getHttpServer())
      .get(`/builds/${buildId}/compatibility`)
      .query({ platform: 'windows', os: 'Windows 11', arch: 'x64' })
      .set('Authorization', `Bearer ${playerToken}`);
    expect(matching.status).toBe(200);
    expect(matching.body).toEqual({
      compatible: true,
      reasons: [],
      supportedPlatforms: ['windows'],
    });

    const mismatched = await request(app.getHttpServer())
      .get(`/builds/${buildId}/compatibility`)
      .query({ platform: 'macos' })
      .set('Authorization', `Bearer ${rivalToken}`);
    expect(mismatched.status).toBe(200);
    expect(mismatched.body.compatible).toBe(false);
    expect(mismatched.body.reasons.length).toBeGreaterThan(0);
    expect(mismatched.body.supportedPlatforms).toEqual(['windows']);
  });

  it('reports incompatible (not an error) while the build has not validated yet', async () => {
    const testId = await createDraftTest(app, studioToken);
    const buildId = uuidv7();
    await sql`
      INSERT INTO builds (id, organization_id, test_id, file_name, storage_key, status)
      SELECT ${buildId}, organization_id, id, 'game.zip', 'fake/storage/key.zip', 'processing'
      FROM tests WHERE id = ${testId}`;

    const compat = await request(app.getHttpServer())
      .get(`/builds/${buildId}/compatibility`)
      .query({ platform: 'windows' })
      .set('Authorization', `Bearer ${playerToken}`);
    expect(compat.status).toBe(200);
    expect(compat.body.compatible).toBe(false);
    expect(compat.body.reasons).toContain('Build ainda não validada');

    const participationId = uuidv7();
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${playerId}, 'ready')`;

    const download = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(download.status).toBe(409);
  });

  it('gates the download URL on an active participation, then on version freshness', async () => {
    const testId = await createDraftTest(app, studioToken);
    await uploadAndConfirmBuild(app, studioToken, testId, 'android', '2.3.1');
    const buildId = await waitForBuildId(app, studioToken, testId);

    const asStudio = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(asStudio.status).toBe(403); // player-only role

    const noParticipation = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(noParticipation.status).toBe(403);

    const participationId = uuidv7();
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${playerId}, 'ready')`;

    const staleLocal = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(staleLocal.status).toBe(200);
    expect(staleLocal.body.needsDownload).toBe(true);
    expect(staleLocal.body.downloadUrl).toEqual(expect.any(String));
    expect(staleLocal.body.version).toBe('2.3.1');
    expect(staleLocal.body.supportsRange).toBe(true);

    const upToDate = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .query({ localVersion: '2.3.1' })
      .set('Authorization', `Bearer ${playerToken}`);
    expect(upToDate.status).toBe(200);
    expect(upToDate.body).toMatchObject({
      needsDownload: false,
      downloadUrl: null,
      expiresAt: null,
      version: '2.3.1',
    });
  });
});
