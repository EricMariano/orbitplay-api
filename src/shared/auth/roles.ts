/**
 * RBAC roles. A user holds a role via a membership in an organization (studio).
 * The role that matters for a request is the one on the ACTIVE membership,
 * carried inside the access token — never taken from the request body
 * (RN-03 / Tela 01).
 */
export const Role = {
  OWNER: 'owner',
  ADMIN: 'admin',
  STUDIO: 'studio',
  PLAYER: 'player',
} as const;

export type RoleValue = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: RoleValue[] = [Role.OWNER, Role.ADMIN, Role.STUDIO, Role.PLAYER];

/** Roles that can act on a studio's own resources (games, etc.). */
export const STUDIO_ROLES: RoleValue[] = [Role.OWNER, Role.ADMIN, Role.STUDIO];

/** The authenticated principal attached to the request by JwtAuthGuard. */
export interface AuthUser {
  userId: string;
  organizationId: string;
  role: RoleValue;
  email: string;
}
