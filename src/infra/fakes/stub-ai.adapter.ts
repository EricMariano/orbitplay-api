import { Injectable } from '@nestjs/common';
import type { AiPort, Insight, InsightRequest } from '../../shared/ports/ai.port';

/** Stub AI adapter: a fixed insight, explicitly flagged as fake. */
@Injectable()
export class StubAiAdapter implements AiPort {
  generateInsight(_request: InsightRequest): Promise<Insight> {
    return Promise.resolve({
      summary: 'Insight de exemplo (stub) — sem IA real nesta etapa.',
      isFake: true,
    });
  }
}
