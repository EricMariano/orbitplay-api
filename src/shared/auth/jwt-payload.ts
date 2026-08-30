import type { RoleValue } from './roles';

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
