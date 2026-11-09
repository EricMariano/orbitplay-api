import type { RoleValue } from './roles';

/**
 * The only algorithm this API signs and accepts. Pinned on every sign/verify so
 * a token can never choose its own (`alg: none`, or an HS/RS confusion if a
 * key type ever changes).
 */
export const JWT_ALGORITHM = 'HS256' as const;

/** Claims carried by the short-lived access token. */
export interface AccessTokenPayload {
  sub: string; // user id
  org: string; // active organization id
  role: RoleValue; // role on the active membership
  email: string;
}

/** Claims carried by the refresh token (rotation family metadata). */
export interface RefreshTokenPayload {
  sub: string; // user id
  org: string; // active organization id
  familyId: string; // rotation family — reuse of any member revokes the family
  tokenId: string; // this specific refresh token's id (jti)
}
