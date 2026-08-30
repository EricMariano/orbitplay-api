import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthUser, RoleValue } from '../auth/roles';

/**
 * Enforces @Roles(...) metadata against the role carried in the access token.
 * A player hitting a studio endpoint gets a 403 in the standard envelope.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleValue[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) throw AppException.unauthorized();

    if (!required.includes(user.role)) {
      throw AppException.forbidden('Seu papel não permite esta ação');
    }
    return true;
  }
}
