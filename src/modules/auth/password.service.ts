import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id password hashing. A precomputed dummy hash lets login verify against
 * SOMETHING even when the user doesn't exist, keeping response time comparable
 * between "unknown user" and "wrong password" (Tela 01 timing requirement).
 */
@Injectable()
export class PasswordService {
  // A valid argon2id hash of a random string — used only to burn equivalent CPU
  // for non-existent users so timing doesn't leak account existence.
  private dummyHash: string | null = null;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Run a verify against a dummy hash to equalize timing; always false. */
  async verifyDummy(plain: string): Promise<boolean> {
    const hash = (this.dummyHash ??= await argon2.hash('this-is-not-a-real-password', {
      type: argon2.argon2id,
    }));
    return this.verify(hash, plain);
  }
}
