import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2EApp } from './helpers/e2e-app';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * `X-Request-Id` goes into every log line and into `audit_log.request_id`, so
 * a client-sent value is only adopted when it is short and plain.
 */
describe('X-Request-Id (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2EApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes a well-formed client id in the header and the error envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('X-Request-Id', 'trace-abc.123_XYZ');

    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBe('trace-abc.123_XYZ');
    expect(res.body.requestId).toBe('trace-abc.123_XYZ');
  });

  it.each([
    ['oversized', 'x'.repeat(129)],
    ['with spaces and markup', '<img src=x onerror=alert(1)> forged'],
    ['with a JSON payload', '{"level":"error","msg":"forged"}'],
  ])('replaces an %s id with a generated UUIDv7', async (_label, sent) => {
    const res = await request(app.getHttpServer()).get('/auth/me').set('X-Request-Id', sent);

    expect(res.status).toBe(401);
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(UUID_V7);
    expect(res.body.requestId).toBe(id);
  });

  it('generates one when the client sends none', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');

    expect(res.headers['x-request-id']).toMatch(UUID_V7);
  });
});
