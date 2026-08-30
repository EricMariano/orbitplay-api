import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a',
  JWT_REFRESH_SECRET: 'b',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'bucket',
  STORAGE_ACCESS_KEY: 'k',
  STORAGE_SECRET_KEY: 's',
  SMTP_HOST: 'localhost',
  WEB_ORIGIN: 'http://localhost:5173',
};

describe('validateEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = validateEnv({ ...validEnv });
    expect(env.PORT).toBe(3000);
    expect(env.ACCESS_TOKEN_TTL).toBe('15m');
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it('fails fast and names the missing variable', () => {
    const missing: Partial<typeof validEnv> = { ...validEnv };
    delete missing.JWT_ACCESS_SECRET;
    expect(() => validateEnv(missing)).toThrowError(/JWT_ACCESS_SECRET/);
  });

  it('rejects an invalid duration format', () => {
    expect(() => validateEnv({ ...validEnv, ACCESS_TOKEN_TTL: '15minutes' })).toThrowError(
      /ACCESS_TOKEN_TTL/,
    );
  });
});
