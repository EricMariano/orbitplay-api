import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { newId } from '../../infra/database/schema/_helpers';
import type { AccessTokenPayload, RefreshTokenPayload } from '../../shared/auth/jwt-payload';

export interface IssuedRefreshToken {
  token: string; // the signed JWT (goes in the httpOnly cookie)
  tokenId: string; // jti — primary key of the stored row
  familyId: string;
  tokenHash: string; // sha256 of the token (only the hash is stored)
  expiresAt: Date;
}

/**
 * Signs/verifies access and refresh tokens and hashes refresh tokens for
 * storage. Only hashes are persisted; the raw refresh token exists solely in
 * the client's httpOnly cookie.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      // Config holds a duration string like "15m"; jsonwebtoken/ms parses it at
      // runtime. Cast bridges the ms StringValue literal-type friction.
      expiresIn: this.config.get<string>('jwt.accessTtl') as unknown as number,
    });
  }

  async createRefreshToken(params: {
    userId: string;
    organizationId: string;
    familyId?: string;
  }): Promise<IssuedRefreshToken> {
    const tokenId = newId();
    const familyId = params.familyId ?? newId();
    const payload: RefreshTokenPayload = {
      sub: params.userId,
      org: params.organizationId,
      familyId,
      tokenId,
    };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.refreshSecret'),
      expiresIn: this.config.get<string>('jwt.refreshTtl') as unknown as number,
    });
    const expiresAt = new Date(Date.now() + this.config.get<number>('jwt.refreshTtlMs')!);
    return { token, tokenId, familyId, tokenHash: this.hashToken(token), expiresAt };
  }

  verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    return this.jwt.verifyAsync<RefreshTokenPayload>(token, {
      secret: this.config.get<string>('jwt.refreshSecret'),
    });
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
