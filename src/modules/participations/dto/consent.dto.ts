import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { testModelKeyValues } from '../../test-models/dto/test-model.dto';

export const consentKindValues = ['screen_recording', 'audio', 'microphone', 'webcam'] as const;

export const tutorialStepSchema = z.object({
  title: z.string(),
  body: z.string(),
  mediaUrl: z.string().nullable(),
});

export const tutorialSchema = z.object({
  modelKey: z.enum(testModelKeyValues),
  steps: z.array(tutorialStepSchema),
  requiredConsents: z.array(z.enum(consentKindValues)),
});

export const consentInputSchema = z.object({
  kind: z.enum(consentKindValues),
  granted: z.boolean(),
});

export const consentRequestSchema = z.object({
  consents: z.array(consentInputSchema).min(1),
});

export const consentRecordSchema = z.object({
  participationId: z.string(),
  consents: z.array(consentInputSchema),
  recordedAt: z.string(),
  allRequiredGranted: z.boolean(),
});

export class TutorialDto extends createZodDto(tutorialSchema) {}
export class ConsentRequestDto extends createZodDto(consentRequestSchema) {}
export class ConsentRecordDto extends createZodDto(consentRecordSchema) {}

export type ConsentKind = (typeof consentKindValues)[number];
export type TutorialView = z.infer<typeof tutorialSchema>;
export type ConsentRequest = z.infer<typeof consentRequestSchema>;
export type ConsentRecordView = z.infer<typeof consentRecordSchema>;
