import { Injectable } from '@nestjs/common';
import type { ParticipationRow } from '../../infra/database/schema/participations';
import type { TestRow } from '../../infra/database/schema/tests';
import { AppException } from '../../shared/errors/app.exception';
import type { PaginationQuery } from '../../shared/pagination/pagination';
import { gameSpecsOf, platformValues, type GameView } from '../games/dto/game.dto';
import { GamesService } from '../games/games.service';
import type {
  PlayerGameView,
  PlayerHomeView,
  PlayerTestList,
  PlayerTestView,
} from './dto/player-catalog.dto';
import { ParticipationsRepository } from './participations.repository';
import { ParticipationsService } from './participations.service';
import { testCta, testUnavailableReason } from './player-cta';

type Platform = (typeof platformValues)[number];
const PLATFORMS = new Set<string>(platformValues);

/**
 * M8-03 — what a player sees of games and tests from ANY organization
 * (Telas 14 e 15). Same cross-org reasoning as the feed and as joining a test:
 * RN-01 governs a studio's own resources, while these are the public face of a
 * game. A `draft` game or test is the studio's private state and reads as 404.
 */
@Injectable()
export class PlayerCatalogService {
  constructor(
    private readonly repo: ParticipationsRepository,
    private readonly participations: ParticipationsService,
    private readonly games: GamesService,
  ) {}

  async getGame(gameId: string): Promise<PlayerGameView> {
    const game = await this.getVisibleGame(gameId);
    const { openTests, maxRewardCents } = await this.repo.findOpenTestStats(game.id, new Date());
    return {
      game,
      playersTotal: game.metrics.playersTotal,
      openTests,
      maxRewardCents,
      specs: gameSpecsOf(game),
    };
  }

  async listGameTests(
    gameId: string,
    userId: string,
    query: PaginationQuery,
  ): Promise<PlayerTestList> {
    const game = await this.getVisibleGame(gameId);
    const page = await this.repo.listPlayerTestsForGame(game.id, query);
    return { data: await this.toViews(page.data, game, userId), nextCursor: page.nextCursor };
  }

  async getTest(testId: string, userId: string): Promise<PlayerTestView> {
    const test = await this.repo.findTestById(testId);
    if (!test || test.status === 'draft') throw AppException.notFound('Teste não encontrado');
    const game = await this.games.getAnyOrg(test.gameId);
    const [view] = await this.toViews([test], game, userId);
    return view;
  }

  /** Tela 13. One aggregate keeps the Home aligned with the user's real participation state. */
  async home(userId: string): Promise<PlayerHomeView> {
    const participations = await this.participations.list(userId, { limit: 4 });
    const testIds = participations.data.map((participation) => participation.testId);
    const testsById = await this.repo.findTestsByIds(testIds);
    const gameIds = [...new Set(participations.data.map((participation) => participation.gameId))];
    const gamesById = new Map(
      await Promise.all(
        gameIds.map(async (gameId) => {
          const game = await this.games.getAnyOrg(gameId);
          return [gameId, game] as const;
        }),
      ),
    );

    const tests = participations.data.flatMap((participation) => {
      const test = testsById.get(participation.testId);
      const game = gamesById.get(participation.gameId);
      if (!test || !game) return [];
      return [
        {
          participationId: participation.id,
          testId: participation.testId,
          gameId: participation.gameId,
          title: test.name ?? game.title,
          coverUrl: game.coverUrl,
          status: participation.status,
          progress: progressForParticipation(participation.status),
          rewardCents: test.rewardAmountCents,
          endsAt: test.endsAt?.toISOString() ?? null,
        },
      ];
    });

    const rewards = await this.repo.listValidatedRewardsForUser(userId);
    const currency = rewards.find((reward) => reward.currency)?.currency ?? 'BRL';
    const compatibleRewards = rewards.filter((reward) => (reward.currency ?? 'BRL') === currency);
    const today = new Date();
    const dayKeys = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 6 + index),
      );
      return day.toISOString().slice(0, 10);
    });
    const amountsByDay = new Map(dayKeys.map((day) => [day, 0]));
    for (const reward of compatibleRewards) {
      if (!reward.validatedAt || reward.rewardCents == null) continue;
      const day = reward.validatedAt.toISOString().slice(0, 10);
      if (amountsByDay.has(day))
        amountsByDay.set(day, (amountsByDay.get(day) ?? 0) + reward.rewardCents);
    }

    return {
      continuing: tests.find((test) => !isFinishedParticipation(test.status)) ?? null,
      tests,
      earnings: {
        currency,
        last7DaysCents: [...amountsByDay.values()].reduce((total, amount) => total + amount, 0),
        totalValidatedCents: compatibleRewards.reduce(
          (total, reward) => total + (reward.rewardCents ?? 0),
          0,
        ),
        series: dayKeys.map((date) => ({ date, amountCents: amountsByDay.get(date) ?? 0 })),
      },
    };
  }

  private async getVisibleGame(gameId: string): Promise<GameView> {
    const game = await this.games.getAnyOrg(gameId);
    if (game.status === 'draft') throw AppException.notFound();
    return game;
  }

  /** All `tests` must belong to `game`. */
  private async toViews(
    tests: TestRow[],
    game: GameView,
    userId: string,
  ): Promise<PlayerTestView[]> {
    const testIds = tests.map((test) => test.id);
    const [platforms, latest] = await Promise.all([
      this.repo.findAudiencePlatforms(testIds),
      this.repo.findLatestParticipations(userId, testIds),
    ]);
    const now = new Date();

    return Promise.all(
      tests.map(async (test) => {
        const participation: ParticipationRow | null = latest.get(test.id) ?? null;
        const { cta, disabledReason } = testCta(
          participation?.status ?? null,
          testUnavailableReason(test, now),
        );
        return {
          testId: test.id,
          gameId: test.gameId,
          title: test.name ?? game.title,
          genre: game.genre,
          coverUrl: game.coverUrl,
          rewardCents: test.rewardAmountCents,
          durationMinutes: null,
          spotsLeft: Math.max(0, test.slotsTotal - test.slotsTaken),
          expiresAt: test.endsAt ? test.endsAt.toISOString() : null,
          platforms: (platforms.get(test.id) ?? []).filter((p): p is Platform => PLATFORMS.has(p)),
          cta,
          disabled: cta === 'unavailable',
          disabledReason,
          promoted: false,
          modelKey: test.modelKey,
          participation: participation
            ? await this.participations.toView(participation, test)
            : null,
        };
      }),
    );
  }
}

function isFinishedParticipation(status: ParticipationRow['status']): boolean {
  return status === 'completed' || status === 'rejected' || status === 'abandoned';
}

function progressForParticipation(status: ParticipationRow['status']): number {
  const progress: Record<ParticipationRow['status'], number> = {
    reserved: 10,
    tutorial: 25,
    downloading: 40,
    ready: 60,
    playing: 75,
    form_pending: 90,
    in_review: 95,
    completed: 100,
    rejected: 100,
    abandoned: 100,
  };
  return progress[status];
}
