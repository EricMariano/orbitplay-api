import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/** Marker nestjs-zod puts on DTO properties whose JSON Schema `type` isn't a single string. */
const EMPTY_TYPE_KEY = 'x-nestjs_zod-empty-type';
const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

type PropertySchema = Record<string, unknown> & { type?: unknown; items?: { type?: unknown } };

/**
 * Zod v4 emits a nullable primitive as `type: ['string', 'null']`. On a DTO's
 * top-level properties @nestjs/swagger reads that array `type` as "array of
 * string" (`type: 'array', items: { type: 'string' }`), so every
 * `z.string().nullable()` field (`nextCursor`, `computedAt`, …) came out as
 * `string[]` in the contract — and `cleanupOpenApiDoc` doesn't catch it.
 *
 * nestjs-zod tags those properties with EMPTY_TYPE_KEY; genuine arrays never
 * carry it (their `type` is the plain string `'array'`). Rewrite the tagged
 * ones back to an OpenAPI 3.0 nullable primitive before the cleanup runs.
 */
export function fixNullablePrimitives(doc: OpenAPIObject): OpenAPIObject {
  for (const schema of Object.values(doc.components?.schemas ?? {})) {
    const properties = (schema as { properties?: Record<string, PropertySchema> }).properties;
    for (const [key, property] of Object.entries(properties ?? {})) {
      const itemType = property.items?.type;
      if (
        property[EMPTY_TYPE_KEY] === true &&
        property.type === 'array' &&
        typeof itemType === 'string' &&
        PRIMITIVE_TYPES.has(itemType)
      ) {
        const fixed: PropertySchema = { ...property, type: itemType, nullable: true };
        delete fixed.items;
        properties![key] = fixed;
      }
    }
  }
  return doc;
}

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

  return cleanupOpenApiDoc(fixNullablePrimitives(SwaggerModule.createDocument(app, builder)));
}
