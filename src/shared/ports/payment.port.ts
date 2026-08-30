/**
 * Payment capability. Money direction (decision §1.2): the STUDIO pays, the
 * tester receives. No real payment code in this task — the FakePaymentAdapter
 * approves instantly with a deterministic id, so the test wizard's /checkout is
 * born from a confirmation, not a front-end click.
 */
export interface ChargeRequest {
  organizationId: string;
  amountCents: number;
  currency: string;
  description: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  paymentId: string;
  status: 'approved' | 'declined' | 'pending';
  approvedAt: string | null;
}

export interface PaymentPort {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

export const PAYMENT_PORT = Symbol('PAYMENT_PORT');
