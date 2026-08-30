import { SetMetadata } from '@nestjs/common';
import type { RoleValue } from '../auth/roles';

export const ROLES_KEY = 'roles';

/** Restricts a route to the given roles. Enforced by RolesGuard. */
export const Roles = (...roles: RoleValue[]) => SetMetadata(ROLES_KEY, roles);
