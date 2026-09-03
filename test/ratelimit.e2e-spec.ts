import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2EApp } from './helpers/e2e-app';

/**
 * Isolated in its own app instance (so its in-memory IP throttle store is fresh)
 * and hammering unique emails so it doesn't disturb other specs' counters.
 * Proves criterion #12: past the limit, auth returns a 429 envelope.
 */
describe('Rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2EApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a 429 envelope once the login limit is exceeded (criterion #12)', async () => {
    const email = 'ratelimit-victim@nowhere.dev';
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 30; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'definitely-wrong' });
      last = { status: res.status, body: res.body };
      if (res.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('TOO_MANY_REQUESTS');
    expect(last.body.requestId).toBeTypeOf('string');
  });

  it('returns a 429 envelope once signup availability IP limit is exceeded (ORB-M1-04)', async () => {
    // Rotate emails so the per-email Redis limit does not fire first — this
    // asserts the dedicated IP `availability` throttler (default 3/60s).
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer())
        .get('/auth/signup/availability')
        .query({ email: `avail-rl-${i}@nowhere.dev` });
      last = { status: res.status, body: res.body };
      if (res.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('TOO_MANY_REQUESTS');
    expect(last.body.requestId).toBeTypeOf('string');
  });
});
