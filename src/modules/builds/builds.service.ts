import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import type { BuildRow } from '../../infra/database/schema/tests';
import { AppException } from '../../shared/errors/app.exception';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import { webBuildPrefix } from '../tests/storage-key';
import type { BuildView } from '../tests/dto/test.dto';
import { toBuildView } from './build-view.mapper';
import { BuildsRepository } from './builds.repository';
import {
  BUILD_DOWNLOAD_TTL_SECONDS,
  type CompatibilityQuery,
  type CompatibilityReport,
  type DownloadUrlQuery,
  type DownloadUrlResponse,
  type PlayLink,
} from './dto/build.dto';
import {
  contentTypeFor,
  normalizeWebPath,
  signPlayToken,
  verifyPlayToken,
  WEB_BUILD_ENTRY_FILE,
} from './web-build';

export interface PlayFile {
  stream: Readable;
  contentType: string;
  sizeBytes: number;
}

@Injectable()
export class BuildsService {
  constructor(
    private readonly repo: BuildsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly config: ConfigService,
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
   * Any account may ask (the player tutorial does), so a caller outside the
   * build's org only learns that it isn't ready — never why (see `unreadyReason`).
   */
  async checkCompatibility(
    callerOrganizationId: string,
    id: string,
    query: CompatibilityQuery,
  ): Promise<CompatibilityReport> {
    const build = await this.findAnyOrgOrThrow(id);
    const reasons: string[] = [];

    if (build.status !== 'validated') {
      reasons.push(unreadyReason(build, callerOrganizationId));
    }
    if (build.platform && build.platform !== query.platform) {
      reasons.push(`Build disponível apenas para ${build.platform}`);
    }

    return {
      compatible: reasons.length === 0,
      reasons,
      supportedPlatforms: build.platform
        ? [build.platform as CompatibilityReport['supportedPlatforms'][number]]
        : [],
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
    callerOrganizationId: string,
    id: string,
    query: DownloadUrlQuery,
  ): Promise<DownloadUrlResponse> {
    const build = await this.findAnyOrgOrThrow(id);

    const active = await this.repo.hasActiveParticipation(build.testId, userId);
    if (!active) {
      throw AppException.forbidden('Sem participação ativa neste teste');
    }
    if (build.status !== 'validated') {
      throw AppException.conflict(unreadyReason(build, callerOrganizationId));
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

  /**
   * Play link for the test's current build when it runs in the browser:
   * a validated `web` build whose files the worker unpacked. `null` for every
   * other build (the player downloads those). The caller already checked the
   * player may play this test (an active session of theirs).
   */
  async playLinkForTest(testId: string): Promise<PlayLink | null> {
    const latest = await this.repo.findLatestBuild(testId);
    const build = latest?.build;
    if (!build || build.status !== 'validated' || build.platform !== 'web') return null;
    const prefix = webBuildPrefix(build.organizationId, build.testId, build.id);
    if (!(await this.storage.exists(prefix + WEB_BUILD_ENTRY_FILE))) return null;
    const { token, expiresAt } = signPlayToken(this.playSecret(), build.id);
    return {
      path: `/builds/${build.id}/play/${token}/${WEB_BUILD_ENTRY_FILE}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * One file of an unpacked web build, for the sandboxed iframe. Anything off
   * — bad/expired token, unknown or no-longer-valid build, path outside the
   * build — is the same `404`, so the route reveals nothing.
   */
  async openPlayFile(id: string, token: string, rawPath: string): Promise<PlayFile> {
    if (!verifyPlayToken(this.playSecret(), id, token)) throw AppException.notFound();
    const path = normalizeWebPath(rawPath.endsWith('/') ? rawPath + WEB_BUILD_ENTRY_FILE : rawPath);
    if (!path) throw AppException.notFound();
    const build = await this.repo.findByIdAnyOrg(id);
    if (!build || build.status !== 'validated' || build.platform !== 'web') {
      throw AppException.notFound();
    }
    const key = webBuildPrefix(build.organizationId, build.testId, build.id) + path;
    const meta = await this.storage.stat(key);
    if (!meta) throw AppException.notFound();
    return {
      stream: await this.storage.getObjectStream(key),
      contentType: contentTypeFor(path),
      sizeBytes: meta.sizeBytes,
    };
  }

  private playSecret(): string {
    return this.config.get<string>('jwt.accessSecret')!;
  }

  private async findAnyOrgOrThrow(id: string): Promise<BuildRow> {
    const build = await this.repo.findByIdAnyOrg(id);
    if (!build) throw AppException.notFound();
    return build;
  }
}

/** What a caller outside the build's org is told — nothing about the build's state. */
const GENERIC_UNREADY_REASON = 'Build indisponível no momento';

/**
 * `failureReason` is the studio's own diagnostic — it can name the malware
 * signature the scanner found — and these routes read builds of any org
 * (`findByIdAnyOrg`). Only the owning org gets the details.
 */
function unreadyReason(build: BuildRow, callerOrganizationId: string): string {
  if (build.organizationId !== callerOrganizationId) return GENERIC_UNREADY_REASON;
  if (build.status === 'failed') return build.failureReason ?? 'Build falhou na validação';
  return 'Build ainda não validada';
}
