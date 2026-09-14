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

describe('PATCH /orgs/current (e2e)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let adminToken: string;
  let studioToken: string;
  let playerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    ownerToken = await bearer(app, SEED_EMAILS.owner);
    adminToken = await bearer(app, SEED_EMAILS.admin);
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await app.close();
  });

  it('owner updates the org name: 200 with the new value', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'OrbitPlay Studio Renomeado' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'OrbitPlay Studio Renomeado' });

    const after = await request(app.getHttpServer())
      .get('/orgs/current')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(after.body.name).toBe('OrbitPlay Studio Renomeado');
  });

  it('admin may update the org (Tela 20)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'OrbitPlay Studio via Admin' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('OrbitPlay Studio via Admin');
  });

  it('studio role cannot update the org: 403', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ name: 'Não deveria' });

    expect(res.status).toBe(403);
  });

  it('player cannot update the org: 403', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ name: 'Não deveria' });

    expect(res.status).toBe(403);
  });

  it('rejects an invalid slug with 422 and a field error', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug: 'Slug Inválido!' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('slug');
  });

  it('rejects an empty name with 422', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '' });

    expect(res.status).toBe(422);
  });

  it('requires authentication: 401 without a token', async () => {
    const res = await request(app.getHttpServer())
      .patch('/orgs/current')
      .send({ name: 'Sem token' });

    expect(res.status).toBe(401);
  });
});
