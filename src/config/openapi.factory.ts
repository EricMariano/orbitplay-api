import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/**
 * Single source of truth for the OpenAPI document. Shared between the live
 * Swagger UI (see main.ts) and the offline `openapi.json` generator (see
 * openapi.ts) so both describe exactly the same contract.
 *
 * `cleanupOpenApiDoc` is required so the Zod-derived (nestjs-zod) schemas come
 * out correct.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('OrbitPlay API')
    .setDescription('OrbitPlay main API — contract consumed by orbitplay-web.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('refresh_token')
    .build();

  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, builder));
}
