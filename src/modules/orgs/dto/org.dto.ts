import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

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

/**
 * Query for GET /orgs/members (ORB-22): cursor pagination (limit/cursor,
 * herdados de paginationQuerySchema) + busca por nome/e-mail (q) + filtros
 * por role e status.
 */
export const memberListQuerySchema = paginationQuerySchema.extend({
  q: z.string().min(1).max(200).optional(),
  role: z.enum(['owner', 'admin', 'studio', 'player']).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
});

export const memberListSchema = z.object({
  data: z.array(memberSchema),
  nextCursor: z.string().nullable(),
});

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
export class MemberListQueryDto extends createZodDto(memberListQuerySchema) {}
export class MemberListDto extends createZodDto(memberListSchema) {}
export class InviteMemberDto extends createZodDto(inviteMemberSchema) {}

export type OrgView = z.infer<typeof orgSchema>;
export type MemberView = z.infer<typeof memberSchema>;
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
