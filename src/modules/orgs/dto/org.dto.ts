import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const orgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
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

/**
 * Change a member's role (ORB-M2-04, Tela 20). `confirm` is typed as the
 * literal `true`: RN-02 treats a role change as a critical action, so an
 * omitted or `false` flag is a validation error, never a silent no-op.
 */
export const changeRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'studio', 'player']),
  confirm: z.literal(true, 'Confirmação explícita obrigatória'),
});

export class OrgDto extends createZodDto(orgSchema) {}
export class MemberDto extends createZodDto(memberSchema) {}
export class MemberListDto extends createZodDto(memberListSchema) {}
export class InviteMemberDto extends createZodDto(inviteMemberSchema) {}
export class ChangeRoleDto extends createZodDto(changeRoleSchema) {}

export type OrgView = z.infer<typeof orgSchema>;
export type MemberView = z.infer<typeof memberSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
