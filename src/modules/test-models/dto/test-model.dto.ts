import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const testModelKeyValues = [
  'free_exploration_telemetry',
  'free_exploration',
  'ab_test',
  'ab_test_images',
] as const;

export type TestModelKey = (typeof testModelKeyValues)[number];

/** RN-03/RN-04 (Tela 06): copy and technical requirements are backend-owned. */
export const testModelSchema = z.object({
  key: z.enum(testModelKeyValues),
  name: z.string(),
  description: z.string(),
  deliverables: z.array(z.string()),
  technicalRequirements: z.array(z.string()),
  requiresTelemetry: z.boolean(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});

export const testModelListSchema = z.object({
  data: z.array(testModelSchema),
});

export type TestModelView = z.infer<typeof testModelSchema>;

export class TestModelDto extends createZodDto(testModelSchema) {}
export class TestModelListDto extends createZodDto(testModelListSchema) {}
