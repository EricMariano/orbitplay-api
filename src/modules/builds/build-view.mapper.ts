import type { BuildView } from '../tests/dto/test.dto';
import type { BuildWithSteps } from './builds.repository';

/** Shared build + validation-steps → `BuildView` mapping (used by both `builds` and `tests`). */
export function toBuildView({ build, steps }: BuildWithSteps): BuildView {
  return {
    id: build.id,
    testId: build.testId,
    status: build.status,
    platform: build.platform as BuildView['platform'],
    version: build.version,
    sizeBytes: build.sizeBytes,
    checksum: build.checksum,
    validationSteps: steps.map((s) => ({ key: s.key, status: s.status, message: s.message })),
    failureReason: build.failureReason,
    createdAt: build.createdAt.toISOString(),
  };
}
