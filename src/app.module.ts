import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { v7 as uuidv7 } from 'uuid';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfiguration } from './config/configuration';
import { validateEnv } from './config/env.schema';
import { DatabaseModule } from './infra/database/database.module';
import { FakesModule } from './infra/fakes/fakes.module';
import { MailModule } from './infra/mail/mail.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.module';
import { TelemetryModule } from './infra/telemetry/telemetry.module';
import { AuditModule } from './modules/audit/audit.module';
import { GamesModule } from './modules/games/games.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrgsModule } from './modules/orgs/orgs.module';
import { HttpExceptionFilter } from './shared/filters/http-exception.filter';
import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';
import { RolesGuard } from './shared/guards/roles.guard';
import { IdempotencyInterceptor } from './shared/interceptors/idempotency.interceptor';

@Module({
  imports: [
    // Boot-time env validation: fails fast, naming the missing/invalid var.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      load: [loadConfiguration],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level:
            config.get<string>('nodeEnv') === 'test'
              ? 'silent'
              : config.get<boolean>('isProduction')
                ? 'info'
                : 'debug',
          // Propagate/gen a requestId, echo it back, and surface it as req.id so
          // it lands in the error envelope and every log line.
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const existing = req.headers['x-request-id'];
            const id = (Array.isArray(existing) ? existing[0] : existing) ?? uuidv7();
            res.setHeader('x-request-id', id);
            return id;
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          transport: config.get<boolean>('isProduction')
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),

    // Infra (all global)
    DatabaseModule,
    RedisModule,
    StorageModule,
    MailModule,
    TelemetryModule,
    FakesModule,
    QueueModule,
    AuditModule,

    // Feature modules
    HealthModule,
    AuthModule,
    OrgsModule,
    GamesModule,
  ],
  providers: [
    // Order matters: authenticate, THEN authorize.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Single validation pipe (Zod) → drives both runtime validation and OpenAPI.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Single error envelope for the whole API.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Idempotency (audit interceptor is registered in AuditModule).
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
