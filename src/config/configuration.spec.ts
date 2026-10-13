import { describe, expect, it } from 'vitest';
import { buildConfig } from './configuration';
import { validateEnv } from './env.schema';

const baseEnv = {
  NODE_ENV: 'development',
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
  CHAT_MESSAGE_THROTTLE_TTL: '10',
  CHAT_MESSAGE_THROTTLE_LIMIT: '10',
};

describe('buildConfig — BUILD_MALWARE_SCAN_BYPASS', () => {
  it('is off unless explicitly enabled', () => {
    expect(buildConfig(validateEnv({ ...baseEnv })).builds.malwareScanBypass).toBe(false);
  });

  it('can be enabled outside production', () => {
    const env = validateEnv({ ...baseEnv, BUILD_MALWARE_SCAN_BYPASS: 'true' });
    expect(buildConfig(env).builds.malwareScanBypass).toBe(true);
  });

  it('refuses to boot with the bypass in production', () => {
    const env = validateEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      BUILD_MALWARE_SCAN_BYPASS: 'true',
    });
    expect(() => buildConfig(env)).toThrow(/not allowed in production/);
  });
});
