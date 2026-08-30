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

export class OrgDto extends createZodDto(orgSchema) {}
export class MemberDto extends createZodDto(memberSchema) {}
export class MemberListDto extends createZodDto(memberListSchema) {}

export type OrgView = z.infer<typeof orgSchema>;
export type MemberView = z.infer<typeof memberSchema>;
