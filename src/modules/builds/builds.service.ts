import { Inject, Injectable } from '@nestjs/common';
import type { BuildRow } from '../../infra/database/schema/tests';
import { AppException } from '../../shared/errors/app.exception';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import type { BuildView } from '../tests/dto/test.dto';
import { toBuildView } from './build-view.mapper';
import { BuildsRepository } from './builds.repository';
import {
  BUILD_DOWNLOAD_TTL_SECONDS,
  type CompatibilityQuery,
  type CompatibilityReport,
  type DownloadUrlQuery,
  type DownloadUrlResponse,
} from './dto/build.dto';

@Injectable()
export class BuildsService {
  constructor(
    private readonly repo: BuildsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async get(organizationId: string, id: string): Promise<BuildView> {
    const build = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    const steps = await this.repo.findValidationSteps(build.id);
    return toBuildView({ build, steps });
  }

  /**
   * RN-03/RN-05 (Telas 14/15): incompatible is a normal `200` with
   * `compatible: false` + readable reasons, never an error. `os`/`arch` are
   * accepted (per the design contract) but not matched against anything —
   * `builds` stores no OS/arch data, only `platform` (DECISIONS.md §3).
   */
  async checkCompatibility(id: string, query: CompatibilityQuery): Promise<CompatibilityReport> {
    const build = await this.findAnyOrgOrThrow(id);
    const reasons: string[] = [];

    if (build.status !== 'validated') {
      reasons.push(unreadyReason(build));
    }
    if (build.platform && build.platform !== query.platform) {
      reasons.push(`Build disponível apenas para ${build.platform}`);
    }

    return {
      compatible: reasons.length === 0,
      reasons,
      supportedPlatforms: build.platform ? [build.platform as CompatibilityReport['supportedPlatforms'][number]] : [],
    };
  }

  /**
   * RN-03 (Tela 16): needs an active participation on the build's test — read
   * straight off `participations` since M8's application layer doesn't exist
   * yet (same pre-M8 pattern as `CommunityService.createReview`, DECISIONS.md
   * §3). The device-compatibility gate this route also declares (`409`) has
   * no per-request platform here (unlike `/compatibility`) and no persisted
   * device profile yet — that's M8's `PATCH /sessions/{id}/devices`. Until
   * then this route gates on build readiness only: an unvalidated build can't
   * be downloaded regardless of device, so `409` covers that case honestly
   * without inventing device data. Full device gating starts working once M8
   * exists, without needing to revisit this route (see DECISIONS.md §3).
   */
  async getDownloadUrl(
    userId: string,
    id: string,
    query: DownloadUrlQuery,
  ): Promise<DownloadUrlResponse> {
    const build = await this.findAnyOrgOrThrow(id);

    const active = await this.repo.hasActiveParticipation(build.testId, userId);
    if (!active) {
      throw AppException.forbidden('Sem participação ativa neste teste');
    }
    if (build.status !== 'validated') {
      throw AppException.conflict(unreadyReason(build));
    }

    const needsDownload = query.localVersion == null || query.localVersion !== build.version;
    const expiresAt = needsDownload
      ? new Date(Date.now() + BUILD_DOWNLOAD_TTL_SECONDS * 1000).toISOString()
      : null;
    const downloadUrl = needsDownload
      ? await this.storage.createDownloadUrl(build.storageKey, BUILD_DOWNLOAD_TTL_SECONDS)
      : null;

    return {
      needsDownload,
      downloadUrl,
      expiresAt,
      version: build.version,
      checksum: build.checksum,
      sizeBytes: build.sizeBytes,
      supportsRange: true,
    };
  }

  private async findAnyOrgOrThrow(id: string): Promise<BuildRow> {
    const build = await this.repo.findByIdAnyOrg(id);
    if (!build) throw AppException.notFound();
    return build;
  }
}

function unreadyReason(build: BuildRow): string {
  if (build.status === 'failed') return build.failureReason ?? 'Build falhou na validação';
  return 'Build ainda não validada';
}
