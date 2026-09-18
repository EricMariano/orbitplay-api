import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthUser } from '../auth/roles';

/**
 * Asserts the request carries an active organization scope. The actual
 * per-row organization filtering lives in BaseRepository (RN-01) — this guard
 * only guarantees an org context exists before a scoped handler runs, so a
 * token without an org can't slip through to the data layer.
 *
 * Registered globally (MAI-01) right after `JwtAuthGuard`, which is where
 * `request.user` gets set — `@Public()` routes never reach that, so this
 * skips them the same way `JwtAuthGuard` does, instead of 401ing them.
 * Every access token this API issues always carries `org` (login/signup
 * fail before a token is minted for an account with no active membership),
 * so this is defense-in-depth against a malformed/tampered token, not a
 * check any legitimate request should ever fail.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) throw AppException.unauthorized();
    if (!user.organizationId) {
      throw AppException.forbidden('Sessão sem organização ativa');
    }
    return true;
  }
}
