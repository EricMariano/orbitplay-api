import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception';
import type { AuthUser } from '../auth/roles';

/**
 * Asserts the request carries an active organization scope. The actual
 * per-row organization filtering lives in BaseRepository (RN-01) — this guard
 * only guarantees an org context exists before a scoped handler runs, so a
 * token without an org can't slip through to the data layer.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) throw AppException.unauthorized();
    if (!user.organizationId) {
      throw AppException.forbidden('Sessão sem organização ativa');
    }
    return true;
  }
}
