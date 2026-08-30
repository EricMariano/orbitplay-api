import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';

/**
 * Generates the versioned openapi.json contract consumed by the web repo to
 * derive its types. `cleanupOpenApiDoc` is required so the Zod-derived schemas
 * come out correct. Run via `pnpm openapi:generate`.
 */
async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();

  const builder = new DocumentBuilder()
    .setTitle('OrbitPlay API')
    .setDescription('OrbitPlay main API — contract consumed by orbitplay-web.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('refresh_token')
    .build();

  const document = SwaggerModule.createDocument(app, builder);
  const cleaned = cleanupOpenApiDoc(document);

  writeFileSync('openapi.json', JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
  console.log('✓ openapi.json generated');

  await app.close();
}

generate().catch((err) => {
  console.error('✗ openapi generation failed');
  console.error(err);
  process.exit(1);
});
