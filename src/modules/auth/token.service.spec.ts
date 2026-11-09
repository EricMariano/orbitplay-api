import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import { TokenService } from './token.service';

const settings: Record<string, unknown> = {
  'jwt.accessSecret': 'access-secret-for-tests-only-0123456789',
  'jwt.refreshSecret': 'refresh-secret-for-tests-only-0123456789',
  'jwt.accessTtl': '15m',
  'jwt.refreshTtl': '30d',
  'jwt.refreshTtlMs': 30 * 24 * 60 * 60 * 1000,
};

const config = { get: (key: string) => settings[key] } as unknown as ConfigService;

function setup() {
  const jwt = new JwtService();
  return { jwt, service: new TokenService(jwt, config) };
}

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('TokenService — algoritmo do JWT', () => {
  it('emite e verifica o refresh token em HS256', async () => {
    const { jwt, service } = setup();
    const issued = await service.createRefreshToken({ userId: 'u1', organizationId: 'o1' });

    expect(jwt.decode(issued.token, { complete: true })?.header.alg).toBe('HS256');
    await expect(service.verifyRefreshToken(issued.token)).resolves.toMatchObject({
      sub: 'u1',
      org: 'o1',
      tokenId: issued.tokenId,
    });
  });

  it('emite o access token em HS256', async () => {
    const { jwt, service } = setup();
    const token = await service.signAccessToken({
      sub: 'u1',
      org: 'o1',
      role: 'player',
      email: 'a@b.co',
    });
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256');
  });

  it('rejeita um refresh token assinado com outro algoritmo, mesmo com o segredo certo', async () => {
    const { jwt, service } = setup();
    const hs512 = await jwt.signAsync(
      { sub: 'u1', org: 'o1', familyId: 'f1', tokenId: 't1' },
      { secret: settings['jwt.refreshSecret'] as string, algorithm: 'HS512', expiresIn: '1h' },
    );
    await expect(service.verifyRefreshToken(hs512)).rejects.toThrow();
  });

  it('rejeita um token sem assinatura (alg "none")', async () => {
    const { service } = setup();
    const unsigned = `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({
      sub: 'u1',
      org: 'o1',
      familyId: 'f1',
      tokenId: 't1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    await expect(service.verifyRefreshToken(unsigned)).rejects.toThrow();
  });
});
