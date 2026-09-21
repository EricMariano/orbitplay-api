import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { platformValues } from '../../games/dto/game.dto';
import { testModelKeyValues } from '../../test-models/dto/test-model.dto';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

/**
 * Enum values below mirror the migrated Drizzle schema
 * (`src/infra/database/schema/{tests,enums}.ts`), not `docs/openapi.design.yaml`.
 * The design doc predates the M5-01 migration and drifted (e.g. `TestStatus`
 * lists `active`/`closed`, the DB has `published`/`finished`); like every other
 * module in this codebase, the migrated schema is the source of truth and the
 * API exposes it directly rather than adding a translation layer. See
 * DECISIONS.md.
 */
export const testStatusValues = ['draft', 'published', 'paused', 'finished', 'expired'] as const;
export const wizardStepValues = ['model', 'form', 'build', 'audience', 'review'] as const;
export const questionTypeValues = [
  'scale',
  'single_choice',
  'multiple_choice',
  'open_text',
  'boolean',
  'nps',
] as const;
export const buildStatusValues = [
  'awaiting_upload',
  'uploading',
  'processing',
  'validated',
  'failed',
] as const;
export const buildStepKeyValues = ['checksum', 'malware_scan', 'metadata', 'plugin_manifest'] as const;
export const buildStepStatusValues = ['processing', 'ready', 'failed', 'unavailable'] as const;

/** `wizard_step` is an ordered enum; the API exposes it as the design's 1-5 integer. */
export const WIZARD_STEP_NUMBER: Record<(typeof wizardStepValues)[number], number> = {
  model: 1,
  form: 2,
  build: 3,
  audience: 4,
  review: 5,
};

/** 5 GiB — game builds, single presigned PUT (no multipart in this phase). */
export const MAX_BUILD_BYTES = 5 * 1024 * 1024 * 1024;
export const BUILD_UPLOAD_TTL_SECONDS = 3600;

export const createTestSchema = z.object({
  testModelKey: z.enum(testModelKeyValues),
  title: z.string().min(1).max(200).optional(),
});

export const setModelSchema = z.object({
  testModelKey: z.enum(testModelKeyValues),
});

export const pendingValidationSchema = z.object({
  step: z.number().int(),
  code: z.string(),
  message: z.string(),
});

export const validationStepSchema = z.object({
  key: z.enum(buildStepKeyValues),
  status: z.enum(buildStepStatusValues),
  message: z.string().nullable(),
});

export const buildSchema = z.object({
  id: z.string(),
  testId: z.string(),
  status: z.enum(buildStatusValues),
  platform: z.enum(platformValues).nullable(),
  version: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  checksum: z.string().nullable(),
  validationSteps: z.array(validationStepSchema),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
});

export const audienceSchema = z.object({
  locations: z.array(z.string()),
  archetypes: z.array(z.string()),
  ageMin: z.number().int(),
  ageMax: z.number().int(),
  quantity: z.number().int(),
  durationDays: z.number().int(),
  deviceRequirements: z.array(z.enum(platformValues)),
  keepActive: z.boolean(),
  estimatedReach: z.number().int(),
});

export const testSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  organizationId: z.string(),
  title: z.string().nullable(),
  status: z.enum(testStatusValues),
  testModelKey: z.enum(testModelKeyValues),
  currentStep: z.number().int().min(1).max(5),
  pendingValidations: z.array(pendingValidationSchema),
  audience: audienceSchema.nullable(),
  build: buildSchema.nullable(),
  spotsTotal: z.number().int().nullable(),
  spotsTaken: z.number().int().nullable(),
  rewardCents: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const formOptionInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(300),
  position: z.number().int().min(0),
});

const formQuestionInputSchema = z
  .object({
    id: z.string().optional(),
    type: z.enum(questionTypeValues),
    prompt: z.string().min(1).max(1000),
    helpText: z.string().max(1000).optional(),
    required: z.boolean(),
    position: z.number().int().min(0),
    options: z.array(formOptionInputSchema).optional(),
    scaleMin: z.number().int().optional(),
    scaleMax: z.number().int().optional(),
  })
  /** RN-02 (Tela 07): choice types need at least two options. */
  .superRefine((q, ctx) => {
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      if (!q.options || q.options.length < 2) {
        ctx.addIssue({
          code: 'custom',
          message: 'Perguntas de escolha exigem ao menos 2 opções',
          path: ['options'],
        });
      }
    }
  });

export const putFormSchema = z
  .object({
    questions: z.array(formQuestionInputSchema),
  })
  /** RN-03: `position` is authority, not array order — but it must still be unique per save. */
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    v.questions.forEach((q, index) => {
      if (seen.has(q.position)) {
        ctx.addIssue({
          code: 'custom',
          message: `Posição ${q.position} duplicada`,
          path: ['questions', index, 'position'],
        });
      }
      seen.add(q.position);
    });
  });

const formOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: z.number().int(),
});

const formQuestionSchema = z.object({
  id: z.string(),
  type: z.enum(questionTypeValues),
  prompt: z.string(),
  helpText: z.string().nullable(),
  required: z.boolean(),
  position: z.number().int(),
  options: z.array(formOptionSchema),
  scaleMin: z.number().int().nullable(),
  scaleMax: z.number().int().nullable(),
});

export const testFormSchema = z.object({
  testId: z.string(),
  questions: z.array(formQuestionSchema),
});

export const buildUploadUrlRequestSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(150),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'Arquivo vazio')
    .max(MAX_BUILD_BYTES, `Arquivo acima de ${MAX_BUILD_BYTES} bytes`),
  platform: z.enum(platformValues),
  version: z.string().max(100).optional(),
});

export const buildUploadUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  storageKey: z.string(),
  expiresAt: z.string(),
  maxSizeBytes: z.number().int(),
});

export const confirmBuildRequestSchema = z.object({
  storageKey: z.string().min(1).max(500),
  platform: z.enum(platformValues),
  version: z.string().max(100).optional(),
  checksum: z.string().max(128).optional(),
});

export const audienceRequestSchema = z
  .object({
    locations: z.array(z.string().max(10)).optional(),
    archetypes: z.array(z.string().max(100)).optional(),
    ageMin: z.number().int().min(18),
    ageMax: z.number().int().max(120),
    quantity: z.number().int().min(1),
    durationDays: z.number().int().min(1).max(365),
    deviceRequirements: z.array(z.enum(platformValues)).optional(),
    keepActive: z.boolean().optional().default(false),
  })
  /** RN-02 (Tela 09): ageMin <= ageMax, both within the 18+ product floor. */
  .superRefine((v, ctx) => {
    if (v.ageMin > v.ageMax) {
      ctx.addIssue({
        code: 'custom',
        message: 'ageMin deve ser menor ou igual a ageMax',
        path: ['ageMin'],
      });
    }
  });

export const setStatusSchema = z.object({
  status: z.enum(['paused', 'published', 'finished']),
});

/**
 * GET /games/:id/tests (Tela 05). `tab` isn't defined anywhere beyond the
 * name in `openapi.design.yaml` — `active` is read here as "still being
 * worked on or currently running" (`draft`/`published`/`paused`), excluding
 * the two terminal states (`finished`/`expired`); same kind of interpretation
 * already made for `GameSpecs`/`estimatedReach` where the handoff doesn't
 * pin the exact rule down. An explicit `status` narrows further and wins
 * over `tab`. See DECISIONS.md §3.
 */
export const testListQuerySchema = paginationQuerySchema.extend({
  tab: z.enum(['active', 'all']).default('active'),
  status: z.enum(testStatusValues).optional(),
});

export const testListSchema = z.object({
  data: z.array(testSchema),
  nextCursor: z.string().nullable(),
});

export class CreateTestDto extends createZodDto(createTestSchema) {}
export class SetModelDto extends createZodDto(setModelSchema) {}
export class TestDto extends createZodDto(testSchema) {}
export class PutFormDto extends createZodDto(putFormSchema) {}
export class TestFormDto extends createZodDto(testFormSchema) {}
export class BuildUploadUrlRequestDto extends createZodDto(buildUploadUrlRequestSchema) {}
export class BuildUploadUrlResponseDto extends createZodDto(buildUploadUrlResponseSchema) {}
export class ConfirmBuildRequestDto extends createZodDto(confirmBuildRequestSchema) {}
export class BuildDto extends createZodDto(buildSchema) {}
export class AudienceRequestDto extends createZodDto(audienceRequestSchema) {}
export class SetStatusDto extends createZodDto(setStatusSchema) {}
export class TestListQueryDto extends createZodDto(testListQuerySchema) {}
export class TestListDto extends createZodDto(testListSchema) {}

export type CreateTestRequest = z.infer<typeof createTestSchema>;
export type SetModelRequest = z.infer<typeof setModelSchema>;
export type TestView = z.infer<typeof testSchema>;
export type PendingValidationView = z.infer<typeof pendingValidationSchema>;
export type AudienceView = z.infer<typeof audienceSchema>;
export type BuildView = z.infer<typeof buildSchema>;
export type ValidationStepView = z.infer<typeof validationStepSchema>;
export type PutFormRequest = z.infer<typeof putFormSchema>;
export type FormQuestionInput = PutFormRequest['questions'][number];
export type TestFormView = z.infer<typeof testFormSchema>;
export type BuildUploadUrlRequest = z.infer<typeof buildUploadUrlRequestSchema>;
export type BuildUploadUrlResponse = z.infer<typeof buildUploadUrlResponseSchema>;
export type ConfirmBuildRequest = z.infer<typeof confirmBuildRequestSchema>;
export type AudienceRequest = z.infer<typeof audienceRequestSchema>;
export type SetStatusRequest = z.infer<typeof setStatusSchema>;
export type TestListQuery = z.infer<typeof testListQuerySchema>;
export type TestStatusValue = (typeof testStatusValues)[number];
export type WizardStepValue = (typeof wizardStepValues)[number];
