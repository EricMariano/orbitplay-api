import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** As quatro colunas da matriz "Responsáveis e permissões" (Tela 04). */
export const accessPermissionsSchema = z.object({
  manageAccess: z.boolean(),
  editInfo: z.boolean(),
  manageTests: z.boolean(),
  viewReports: z.boolean(),
});

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int(),
  memberUserIds: z.array(z.string()),
  createdAt: z.string(),
});

export const groupListSchema = z.object({ data: z.array(groupSchema) });

const groupNameField = z.string().trim().min(1, 'Nome obrigatório').max(100);
const memberIds = z.array(z.string().uuid()).max(200);

export const createGroupSchema = z.object({
  name: groupNameField,
  memberUserIds: memberIds.default([]),
});

export const updateGroupSchema = z.object({
  name: groupNameField.optional(),
  memberUserIds: memberIds.optional(),
});

export const accessSubjectTypeValues = ['group', 'member'] as const;

export const gameAccessEntrySchema = z.object({
  subjectType: z.enum(accessSubjectTypeValues),
  subjectId: z.string(),
  name: z.string(),
  /** Só para `member`. */
  email: z.string().nullable(),
  /** Só para `group`. */
  memberCount: z.number().int().nullable(),
  permissions: accessPermissionsSchema,
});

export const gameAccessListSchema = z.object({ data: z.array(gameAccessEntrySchema) });

/** PUT /games/:id/access — substitui a lista inteira de destinatários. */
export const setGameAccessSchema = z.object({
  entries: z
    .array(
      z.object({
        subjectType: z.enum(accessSubjectTypeValues),
        subjectId: z.string().uuid(),
        permissions: accessPermissionsSchema,
      }),
    )
    .max(100),
});

export class GroupDto extends createZodDto(groupSchema) {}
export class GroupListDto extends createZodDto(groupListSchema) {}
export class CreateGroupDto extends createZodDto(createGroupSchema) {}
export class UpdateGroupDto extends createZodDto(updateGroupSchema) {}
export class GameAccessListDto extends createZodDto(gameAccessListSchema) {}
export class SetGameAccessDto extends createZodDto(setGameAccessSchema) {}

export type AccessPermissions = z.infer<typeof accessPermissionsSchema>;
export type GroupView = z.infer<typeof groupSchema>;
export type GameAccessEntryView = z.infer<typeof gameAccessEntrySchema>;
export type GameAccessListView = z.infer<typeof gameAccessListSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type SetGameAccessInput = z.infer<typeof setGameAccessSchema>;
