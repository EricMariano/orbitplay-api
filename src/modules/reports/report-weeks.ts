import type { EvolutionPayload } from './dto/report.dto';

type EvolutionPoint = EvolutionPayload['points'][number];
type EvolutionWeek = EvolutionPayload['weeks'][number];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Agrupa os pontos diários da evolução em semanas contadas a partir de
 * `startDate` (`YYYY-MM-DD`, início do teste) — ou do 1º ponto, sem início
 * definido. Semanas sem sessão entre a primeira e a última entram com zero,
 * para o gráfico não "pular" uma semana parada. Pontos anteriores ao início
 * (sessão de QA antes da publicação) contam na semana 1.
 */
export function groupEvolutionByWeek(
  points: EvolutionPoint[],
  startDate: string | null,
): EvolutionWeek[] {
  if (points.length === 0) return [];
  const base = Date.parse(`${startDate ?? points[0].date}T00:00:00Z`);

  const counts = new Map<number, number>();
  for (const p of points) {
    const offset = Date.parse(`${p.date}T00:00:00Z`) - base;
    const week = Math.max(1, Math.floor(offset / WEEK_MS) + 1);
    counts.set(week, (counts.get(week) ?? 0) + p.sessions);
  }

  const lastWeek = Math.max(...counts.keys());
  const weeks: EvolutionWeek[] = [];
  for (let week = 1; week <= lastWeek; week++) {
    weeks.push({
      week,
      startDate: new Date(base + (week - 1) * WEEK_MS).toISOString().slice(0, 10),
      sessions: counts.get(week) ?? 0,
    });
  }
  return weeks;
}
