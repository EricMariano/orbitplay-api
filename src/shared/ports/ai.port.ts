/**
 * AI insight capability. StubAiAdapter returns a fixed insight flagged as fake
 * in this task; a real LLM implements this later. No real AI code now.
 */
export interface InsightRequest {
  organizationId: string;
  context: Record<string, unknown>;
}

export interface Insight {
  summary: string;
  isFake: boolean;
}

export interface AiPort {
  generateInsight(request: InsightRequest): Promise<Insight>;
}

export const AI_PORT = Symbol('AI_PORT');
