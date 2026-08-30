import { Global, Module } from '@nestjs/common';
import { AI_PORT } from '../../shared/ports/ai.port';
import { ASR_PORT } from '../../shared/ports/asr.port';
import { PAYMENT_PORT } from '../../shared/ports/payment.port';
import { FakePaymentAdapter } from './fake-payment.adapter';
import { StubAiAdapter } from './stub-ai.adapter';
import { StubAsrAdapter } from './stub-asr.adapter';

/**
 * Registers the fake/stub adapters for out-of-scope capabilities (payment, AI,
 * ASR). They are wired now — even without a consumer — so the first consumer
 * uses the port instead of inventing a direct call. Swap these for real
 * adapters later without touching callers.
 */
@Global()
@Module({
  providers: [
    { provide: PAYMENT_PORT, useClass: FakePaymentAdapter },
    { provide: AI_PORT, useClass: StubAiAdapter },
    { provide: ASR_PORT, useClass: StubAsrAdapter },
  ],
  exports: [PAYMENT_PORT, AI_PORT, ASR_PORT],
})
export class FakesModule {}
