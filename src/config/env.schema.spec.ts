import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a',
  JWT_REFRESH_SECRET: 'b',
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'bucket',
  STORAGE_ACCESS_KEY: 'k',
  STORAGE_SECRET_KEY: 's',
  STORAGE_FORCE_PATH_STYLE: 'true',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'no-reply@orbitplay.dev',
  WEB_ORIGIN: 'http://localhost:5173',
  AUTH_THROTTLE_TTL: '60',
  AUTH_THROTTLE_LIMIT: '5',
  AUTH_AVAILABILITY_THROTTLE_TTL: '60',
  AUTH_AVAILABILITY_THROTTLE_LIMIT: '3',
  PASSWORD_RESET_TTL: '1h',
};

describe('validateEnv', () => {
  it('accepts a complete environment and coerces/transforms values', () => {
    const env = validateEnv({ ...validEnv });
    expect(env.PORT).toBe(3000);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.ACCESS_TOKEN_TTL).toBe('15m');
    expect(env.PASSWORD_RESET_TTL).toBe('1h');
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(true);
    expect(env.AUTH_THROTTLE_LIMIT).toBe(5);
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

  // CFG-01 regression: every variable documented in .env.example is required.
  // None of them may carry a silent Zod default — deleting one must fail boot
  // naming that exact variable, never fall back unnoticed.
  const requiredVars = Object.keys(validEnv) as (keyof typeof validEnv)[];

  it.each(requiredVars)('fails fast when %s is missing', (key) => {
    const missing: Partial<typeof validEnv> = { ...validEnv };
    delete missing[key];
    expect(() => validateEnv(missing)).toThrowError(new RegExp(key));
  });
});
