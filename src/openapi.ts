import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './config/openapi.factory';

/**
 * Generates the versioned openapi.json contract consumed by the web repo to
 * derive its types. `cleanupOpenApiDoc` is required so the Zod-derived schemas
 * come out correct. Run via `pnpm openapi:generate`.
 */
async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();

  const document = buildOpenApiDocument(app);

  writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n', 'utf8');
  console.log('✓ openapi.json generated');

  await app.close();
}

generate().catch((err) => {
  console.error('✗ openapi generation failed');
  console.error(err);
  process.exit(1);
});
