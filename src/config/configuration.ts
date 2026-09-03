import { validateEnv, type Env } from './env.schema';

/**
 * Convert a duration string ("15m", "30d", "900s", "500ms") into milliseconds.
 * Kept tiny and local so we don't pull in an extra dependency for it.
 */
export function durationToMs(input: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const value = Number(match[1]);
  const unit = match[2];
  const factors: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * factors[unit];
}

/**
 * The typed, structured configuration object derived from the validated env.
 * Registered under the ConfigService so the rest of the app never touches
 * process.env directly.
 */
export function buildConfig(env: Env) {
  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtl: env.ACCESS_TOKEN_TTL,
      refreshTtl: env.REFRESH_TOKEN_TTL,
      refreshTtlMs: durationToMs(env.REFRESH_TOKEN_TTL),
    },
    storage: {
      endpoint: env.STORAGE_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY,
      secretKey: env.STORAGE_SECRET_KEY,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    },
    mail: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      from: env.MAIL_FROM,
    },
    web: {
      origin: env.WEB_ORIGIN,
    },
    authThrottle: {
      ttl: env.AUTH_THROTTLE_TTL,
      limit: env.AUTH_THROTTLE_LIMIT,
      availabilityTtl: env.AUTH_AVAILABILITY_THROTTLE_TTL,
      availabilityLimit: env.AUTH_AVAILABILITY_THROTTLE_LIMIT,
    },
    auth: {
      passwordResetTtl: env.PASSWORD_RESET_TTL,
      passwordResetTtlMs: durationToMs(env.PASSWORD_RESET_TTL),
    },
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

/**
 * ConfigModule `load` factory: validate env and expose the nested config so the
 * app reads config.get('jwt.accessSecret') etc., never process.env directly.
 */
export function loadConfiguration(): AppConfig {
  return buildConfig(validateEnv(process.env));
}
