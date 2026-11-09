import type { INestApplication } from '@nestjs/common';
import { Worker } from 'bullmq';
import { strToU8, zipSync } from 'fflate';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { redisConnectionOptions } from '../src/infra/queue/connection';
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

// A player whose (personal) org is not the studio's — the seed player shares
// the studio's org (DECISIONS.md §1.1), so it can't show a cross-org leak.
const OUTSIDER = {
  userId: '01996000-0000-7000-8000-0000000000e2',
  orgId: '01996000-0000-7000-8000-0000000000f2',
  membershipId: '01996000-0000-7000-8000-0000000000ea',
  email: 'outsider-builds@player.dev',
};

// Starts with the zip signature — the build worker sniffs magic bytes against
// the declared `.zip` extension.
const BUILD_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('fake-game-build-bytes'),
]);

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
  bytes: Buffer = BUILD_BYTES,
): Promise<{ uploadUrl: string; storageKey: string }> {
  const uploadUrl = await request(app.getHttpServer())
    .post(`/tests/${testId}/build/upload-url`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      fileName: 'game.zip',
      contentType: 'application/zip',
      sizeBytes: bytes.length,
      platform,
    });
  await fetch(uploadUrl.body.uploadUrl as string, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: bytes,
  });
  const confirm = await request(app.getHttpServer())
    .post(`/tests/${testId}/build`)
    .set('Authorization', `Bearer ${token}`)
    .send({ storageKey: uploadUrl.body.storageKey, platform, version });
  expect(confirm.status).toBe(202);
  return {
    uploadUrl: uploadUrl.body.uploadUrl as string,
    storageKey: uploadUrl.body.storageKey as string,
  };
}

async function waitForBuildId(
  app: INestApplication,
  token: string,
  testId: string,
): Promise<string> {
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
  let outsiderToken: string;

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

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${OUTSIDER.userId}, ${OUTSIDER.email}, password_hash, 'Outsider Player'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${OUTSIDER.orgId}, 'Conta de Outsider', 'outsider-builds-player', ${OUTSIDER.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${OUTSIDER.membershipId}, ${OUTSIDER.orgId}, ${OUTSIDER.userId},
              (SELECT id FROM roles WHERE key = 'player'))
      ON CONFLICT DO NOTHING`;

    workerDeps = await createWorkerDeps();
    worker = new Worker(MAIN_QUEUE, (job) => handleJob(job, workerDeps), {
      connection: redisConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
    await worker.waitUntilReady();

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);
    outsiderToken = await bearer(app, OUTSIDER.email);

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
  // A studio could upload a clean file, wait for `validated`, then re-PUT
  // other bytes through the upload URL (valid for 1h) — players downloaded
  // them under the validated badge. The worker now validates and serves a
  // server-side copy no presigned URL was ever issued for.
  it('serves the validated copy: a re-PUT through the still-live upload URL never reaches players', async () => {
    const testId = await createDraftTest(app, studioToken);
    const upload = await uploadAndConfirmBuild(app, studioToken, testId, 'windows', '3.0.0');
    const buildId = await waitForBuildId(app, studioToken, testId);

    const [row] = await sql`SELECT status, storage_key FROM builds WHERE id = ${buildId}`;
    expect(row.status).toBe('validated');
    const validatedKey = upload.storageKey.replace(/\/([^/]+)$/, '/validated/$1');
    expect(row.storage_key).toBe(validatedKey);
    // The upload itself goes right after the approving write.
    const deadline = Date.now() + 5_000;
    while ((await workerDeps.storage.stat(upload.storageKey)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await workerDeps.storage.stat(upload.storageKey)).toBeNull();

    // Same length on purpose: the presigned PUT signs Content-Length.
    const swapped = Buffer.alloc(BUILD_BYTES.length, 0x41);
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: swapped,
    });
    expect(put.ok).toBe(true);

    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${uuidv7()}, ${testId}, ${playerId}, 'ready')`;
    const download = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(download.status).toBe(200);

    const served = Buffer.from(
      await (await fetch(download.body.downloadUrl as string)).arrayBuffer(),
    );
    expect(served.equals(BUILD_BYTES)).toBe(true);
  });

  // `/compatibility` answers any account (the player tutorial uses it) and
  // `failureReason` can carry the malware signature the scanner found.
  it('never shows another org why a build failed — compatibility and download-url', async () => {
    const testId = await createDraftTest(app, studioToken);
    const buildId = uuidv7();
    const threat = 'Ameaça detectada: Win.Test.EICAR_HDB-1';
    await sql`
      INSERT INTO builds (id, organization_id, test_id, file_name, storage_key, status,
                          failure_reason, platform)
      SELECT ${buildId}, organization_id, id, 'game.zip', 'fake/storage/key.zip', 'failed',
             ${threat}, 'windows'
      FROM tests WHERE id = ${testId}`;

    const asOwner = await request(app.getHttpServer())
      .get(`/builds/${buildId}/compatibility`)
      .query({ platform: 'windows' })
      .set('Authorization', `Bearer ${studioToken}`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.reasons).toContain(threat);

    for (const token of [rivalToken, outsiderToken]) {
      const crossOrg = await request(app.getHttpServer())
        .get(`/builds/${buildId}/compatibility`)
        .query({ platform: 'windows' })
        .set('Authorization', `Bearer ${token}`);
      expect(crossOrg.status).toBe(200);
      expect(crossOrg.body).toEqual({
        compatible: false,
        reasons: ['Build indisponível no momento'],
        supportedPlatforms: ['windows'],
      });
    }

    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${uuidv7()}, ${testId}, ${OUTSIDER.userId}, 'ready')`;
    const outsiderDownload = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(outsiderDownload.status).toBe(409);
    expect(JSON.stringify(outsiderDownload.body)).not.toContain('EICAR');

    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${uuidv7()}, ${testId}, ${playerId}, 'ready')`;
    const sameOrgDownload = await request(app.getHttpServer())
      .get(`/builds/${buildId}/download-url`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(sameOrgDownload.status).toBe(409);
    expect(sameOrgDownload.body.message).toBe(threat);
  });

  it('runs a validated web build in the browser: gameplay hands out a signed play link', async () => {
    const testId = await createDraftTest(app, studioToken);
    const webZip = Buffer.from(
      zipSync({
        'jogo/index.html': strToU8('<!doctype html><script src="js/game.js"></script>'),
        'jogo/js/game.js': strToU8('console.log("oi")'),
      }),
    );
    await uploadAndConfirmBuild(app, studioToken, testId, 'web', '1.0.0', webZip);
    const buildId = await waitForBuildId(app, studioToken, testId);
    const build = await request(app.getHttpServer())
      .get(`/builds/${buildId}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(build.body.status).toBe('validated');

    const participationId = uuidv7();
    const sessionId = uuidv7();
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${playerId}, 'ready')`;
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status)
      SELECT ${sessionId}, ${participationId}, id, organization_id, 'recording'
      FROM tests WHERE id = ${testId}`;

    const gameplay = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}/gameplay`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(gameplay.status).toBe(200);
    const path = gameplay.body.play?.path as string;
    expect(path).toMatch(new RegExp(`^/builds/${buildId}/play/[^/]+/index\\.html$`));

    // No bearer: the iframe can't send one — the token in the path is the gate.
    const page = await request(app.getHttpServer()).get(path);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.text).toContain('js/game.js');
    expect(page.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    expect(page.headers['content-security-policy']).toContain('frame-ancestors');
    expect(page.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(page.headers['x-frame-options']).toBeUndefined();

    const asset = await request(app.getHttpServer()).get(path.replace('index.html', 'js/game.js'));
    expect(asset.status).toBe(200);
    expect(asset.text).toBe('console.log("oi")');

    const base = path.replace(/\/index\.html$/, '');
    const forged = base.replace(/\.[^./]+$/, '.forged');
    for (const url of [
      `${forged}/index.html`,
      `${base}/missing.js`,
      `${base}/..%2F..%2Fvalidated%2Fgame.zip`,
      `/builds/${uuidv7()}${base.slice(base.indexOf('/play/'))}/index.html`,
    ]) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status, url).toBe(404);
    }

    // Once the session is over there is nothing left to play.
    await sql`UPDATE sessions SET status = 'completed' WHERE id = ${sessionId}`;
    const over = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}/gameplay`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(over.body.play).toBeNull();
  });

  it('fails a web build whose zip has no index.html', async () => {
    const testId = await createDraftTest(app, studioToken);
    const zip = Buffer.from(zipSync({ 'game.exe': strToU8('MZ') }));
    await uploadAndConfirmBuild(app, studioToken, testId, 'web', '1.0.0', zip);
    await waitForBuildId(app, studioToken, testId);

    const build = await request(app.getHttpServer())
      .get(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(build.body.status).toBe('failed');
    expect(build.body.failureReason).toContain('index.html');
  });
});
