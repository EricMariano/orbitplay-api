import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const orgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});

const orgSlugField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug deve ser kebab-case (a-z, 0-9, hífen)');

/** ORB-M2-02 (Tela 20): atualiza dados da própria org — owner/admin, todo campo opcional. */
export const updateOrgSchema = z.object({
  name: z.string().min(1, 'Nome obrigatório').max(200).optional(),
  slug: orgSlugField.optional(),
});

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'admin', 'studio', 'player']),
  status: z.enum(['active', 'invited', 'disabled']),
});

export const memberListSchema = z.object({ data: z.array(memberSchema) });

/**
 * Invite a member (ORB-M2-03, Tela 20). Creates an `invited` membership and
 * sends the invitation e-mail — it never sets a password: the invitee defines
 * theirs through the password recovery flow (RN-04).
 */
export const inviteMemberSchema = z.object({
  email: z.string().min(1, 'E-mail obrigatório').email('E-mail inválido'),
  displayName: z.string().min(1).max(200).optional(),
  role: z.enum(['owner', 'admin', 'studio', 'player']),
});

export class OrgDto extends createZodDto(orgSchema) {}
export class MemberDto extends createZodDto(memberSchema) {}
export class MemberListDto extends createZodDto(memberListSchema) {}
export class InviteMemberDto extends createZodDto(inviteMemberSchema) {}
export class UpdateOrgDto extends createZodDto(updateOrgSchema) {}

export type OrgView = z.infer<typeof orgSchema>;
export type MemberView = z.infer<typeof memberSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;
