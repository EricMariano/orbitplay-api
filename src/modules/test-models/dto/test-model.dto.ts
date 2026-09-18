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
  /**
   * GAP-03: whether the wizard's build step is a real publish gate for this
   * model — `ab_test_images` compares images, not a playable build, so
   * `publish` must not block on `BUILD_NOT_VALIDATED` for it the way it does
   * for every other model.
   */
  requiresBuild: z.boolean(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});

export const testModelListSchema = z.object({
  data: z.array(testModelSchema),
});

export type TestModelView = z.infer<typeof testModelSchema>;

export class TestModelDto extends createZodDto(testModelSchema) {}
export class TestModelListDto extends createZodDto(testModelListSchema) {}
