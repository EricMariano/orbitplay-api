import { Injectable } from '@nestjs/common';
import { AppException } from '../../shared/errors/app.exception';
import type { MemberView, OrgView } from './dto/org.dto';
import { OrgsRepository } from './orgs.repository';

@Injectable()
export class OrgsService {
  constructor(private readonly repo: OrgsRepository) {}

  async getCurrent(organizationId: string): Promise<OrgView> {
    const org = await this.repo.findById(organizationId);
    if (!org) throw AppException.notFound('Organização não encontrada');
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt.toISOString(),
    };
  }

  async listMembers(organizationId: string): Promise<{ data: MemberView[] }> {
    const members = await this.repo.listMembers(organizationId);
    return {
      data: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        displayName: m.displayName,
        role: m.role as MemberView['role'],
        status: m.status as MemberView['status'],
      })),
    };
  }
}
