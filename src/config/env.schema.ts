import { z } from 'zod';

/**
 * Environment schema — the single source of truth for what the API needs to
 * boot. Every variable is REQUIRED unless it carries a default here. The app
 * validates process.env against this on boot (see configuration.ts) and fails
 * fast, pointing at the offending variable, instead of blowing up on the first
 * request.
 */
const durationString = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'must be a duration like "15m", "30d", "900s"');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  ACCESS_TOKEN_TTL: durationString.default('15m'),
  REFRESH_TOKEN_TTL: durationString.default('30d'),

  STORAGE_ENDPOINT: z.string().url('STORAGE_ENDPOINT must be a URL'),
  STORAGE_BUCKET: z.string().min(1, 'STORAGE_BUCKET is required'),
  STORAGE_ACCESS_KEY: z.string().min(1, 'STORAGE_ACCESS_KEY is required'),
  STORAGE_SECRET_KEY: z.string().min(1, 'STORAGE_SECRET_KEY is required'),
  STORAGE_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  MAIL_FROM: z.string().min(1).default('no-reply@orbitplay.dev'),

  WEB_ORIGIN: z.string().url('WEB_ORIGIN must be a URL'),

  AUTH_THROTTLE_TTL: z.coerce.number().int().positive().default(60),
  AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(5),

  /** Stricter IP throttle for signup email-availability checks (anti-enumeration). */
  AUTH_AVAILABILITY_THROTTLE_TTL: z.coerce.number().int().positive().default(60),
  AUTH_AVAILABILITY_THROTTLE_LIMIT: z.coerce.number().int().positive().default(3),

  /** Lifetime of a password-reset token (raw value lives only in the e-mail). */
  PASSWORD_RESET_TTL: durationString.default('1h'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse & validate raw env. Throws a readable, multi-line error naming every
 * missing/invalid variable. Used as the ConfigModule `validate` hook so the
 * failure happens at boot.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration. Fix your .env (see .env.example):\n${issues}`,
    );
  }
  return result.data;
}
