import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Test models (e2e)', () => {
  let app: INestApplication;
  let studioToken: string;
  let playerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await app.close();
  });

  it('a studio role lists the four designed models', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-models')
      .set('Authorization', `Bearer ${studioToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { key: string }) => m.key)).toEqual([
      'free_exploration',
      'free_exploration_telemetry',
      'ab_test',
      'ab_test_images',
    ]);
  });

  it('a player role gets 403 on both routes', async () => {
    const list = await request(app.getHttpServer())
      .get('/test-models')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('FORBIDDEN');

    const detail = await request(app.getHttpServer())
      .get('/test-models/ab_test')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(detail.status).toBe(403);
  });

  it('an unauthenticated request gets 401', async () => {
    const res = await request(app.getHttpServer()).get('/test-models');
    expect(res.status).toBe(401);
  });

  it('returns free_exploration_telemetry as unavailable, with a reason', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-models/free_exploration_telemetry')
      .set('Authorization', `Bearer ${studioToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: 'free_exploration_telemetry',
      requiresTelemetry: true,
      available: false,
    });
    expect(res.body.unavailableReason).toBeTruthy();
  });

  it('returns 404 in the standard envelope for an unknown key', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-models/not_a_real_model')
      .set('Authorization', `Bearer ${studioToken}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBeTruthy();
  });
});
