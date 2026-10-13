import type { OpenAPIObject } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { fixNullablePrimitives } from './openapi.factory';

function docWith(properties: Record<string, unknown>): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {},
    components: { schemas: { Dto: { type: 'object', properties } } },
  } as OpenAPIObject;
}

function propertiesOf(doc: OpenAPIObject): Record<string, unknown> {
  return (doc.components!.schemas!.Dto as { properties: Record<string, unknown> }).properties;
}

describe('fixNullablePrimitives', () => {
  it('turns a nullable primitive misread as an array back into a nullable primitive', () => {
    const doc = docWith({
      nextCursor: { 'x-nestjs_zod-empty-type': true, type: 'array', items: { type: 'string' } },
      rating: { 'x-nestjs_zod-empty-type': true, type: 'array', items: { type: 'number' } },
    });

    const props = propertiesOf(fixNullablePrimitives(doc));

    expect(props.nextCursor).toMatchObject({ type: 'string', nullable: true });
    expect(props.nextCursor).not.toHaveProperty('items');
    expect(props.rating).toMatchObject({ type: 'number', nullable: true });
  });

  it('leaves genuine arrays alone (no empty-type marker)', () => {
    const languages = { type: 'array', items: { type: 'string' } };
    const props = propertiesOf(fixNullablePrimitives(docWith({ languages })));

    expect(props.languages).toEqual(languages);
  });

  it('leaves anyOf-based nullables alone', () => {
    const platform = {
      'x-nestjs_zod-empty-type': true,
      anyOf: [{ type: 'string', enum: ['web'] }, { type: 'null' }],
    };
    const props = propertiesOf(fixNullablePrimitives(docWith({ platform })));

    expect(props.platform).toEqual(platform);
  });
});
