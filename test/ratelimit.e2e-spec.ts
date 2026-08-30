import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2EApp } from './helpers/e2e-app';

/**
 * Isolated in its own app instance (so its in-memory IP throttle store is fresh)
 * and hammering a unique, unused email so it doesn't disturb other specs' login
 * counters. Proves criterion #12: past the limit, login returns a 429 envelope.
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
});
