import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ChargeRequest, ChargeResult, PaymentPort } from '../../shared/ports/payment.port';

/**
 * Fake payment adapter: approves instantly and returns a DETERMINISTIC id
 * derived from the idempotency key, so replays map to the same payment. This
 * exists even without real payments — the test wizard's /checkout calls it so a
 * test is born from a confirmation, not a front-end click.
 */
@Injectable()
export class FakePaymentAdapter implements PaymentPort {
  charge(request: ChargeRequest): Promise<ChargeResult> {
    const paymentId =
      'fake_' +
      createHash('sha256')
        .update(`${request.organizationId}:${request.idempotencyKey}`)
        .digest('hex')
        .slice(0, 24);

    return Promise.resolve({
      paymentId,
      status: 'approved',
      // Deterministic timestamp (epoch) — the fake never depends on wall clock.
      approvedAt: new Date(0).toISOString(),
    });
  }
}
