import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './config/openapi.factory';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Route Nest's logs through pino (structured, with requestId).
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get<string>('web.origin'),
    credentials: true, // allow the refresh-token cookie
  });
  app.enableShutdownHooks(); // triggers onModuleDestroy → close DB/Redis

  // Interactive API docs (Swagger UI) at /docs, contract JSON at /docs-json.
  // Same document the offline generator writes to openapi.json.
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  app.get(Logger).log(`OrbitPlay API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
