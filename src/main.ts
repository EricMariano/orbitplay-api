import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './config/openapi.factory';
import { RedisIoAdapter } from './infra/redis/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Route Nest's logs through pino (structured, with requestId).
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get<string[]>('web.allowedOrigins'),
    credentials: true, // allow the refresh-token cookie
  });
  app.enableShutdownHooks(); // triggers onModuleDestroy → close DB/Redis

  // Chat runs over Socket.IO; the Redis adapter makes a broadcast reach every
  // replica, not just the one the sender happens to be connected to.
  const wsAdapter = new RedisIoAdapter(app);
  await wsAdapter.connect();
  app.useWebSocketAdapter(wsAdapter);

  // Interactive API docs (Swagger UI) at /docs, contract JSON at /docs-json.
  // Same document the offline generator writes to openapi.json. Dev only: in
  // production it would hand anyone the full map of routes and payloads (the
  // contract still ships as openapi.json, generated offline).
  if (!config.get<boolean>('isProduction')) {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  app.get(Logger).log(`OrbitPlay API listening on http://localhost:${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // Fail fast and loud (e.g. Redis unreachable at boot) so the orchestrator restarts the container.
  console.error('✗ bootstrap failed');
  console.error(error);
  process.exit(1);
});
