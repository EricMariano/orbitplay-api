import { and, eq } from 'drizzle-orm';
import { buildValidationSteps, builds } from '../infra/database/schema/tests';
import type { WorkerDeps } from './deps';

type BuildStepKey = 'checksum' | 'malware_scan' | 'metadata';

/**
 * Fake validation pipeline — no real malware/AV integration in this phase,
 * same documented-stub shape as `processMediaTranscode`. It confirms the
 * object actually landed in storage, then marks each step ready; a missing
 * object fails the build with a reason the studio can act on (RN-05, Tela
 * 08). `plugin_manifest` is a reserved future step (ORB-M6-02 scope) and is
 * never instantiated here.
 */
export async function processBuildValidate(deps: WorkerDeps, buildId: string): Promise<void> {
  const rows = await deps.db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
  const build = rows[0];
  if (!build) throw new Error(`build ${buildId} not found`);

  const meta = await deps.storage.stat(build.storageKey);
  if (!meta) {
    const reason = 'Arquivo não encontrado no storage';
    await setStep(deps, buildId, 'checksum', 'failed', reason);
    await deps.db
      .update(builds)
      .set({ status: 'failed', failureReason: reason })
      .where(eq(builds.id, buildId));
    return;
  }

  await setStep(deps, buildId, 'checksum', 'ready', `Objeto confirmado (${meta.sizeBytes} bytes)`);
  await setStep(deps, buildId, 'malware_scan', 'ready', 'Nenhuma ameaça detectada (verificação simulada)');
  await setStep(deps, buildId, 'metadata', 'ready', 'Metadados consistentes');

  await deps.db
    .update(builds)
    .set({ status: 'validated', failureReason: null })
    .where(eq(builds.id, buildId));
}

async function setStep(
  deps: WorkerDeps,
  buildId: string,
  key: BuildStepKey,
  status: 'ready' | 'failed',
  message: string,
): Promise<void> {
  await deps.db
    .update(buildValidationSteps)
    .set({ status, message, finishedAt: new Date() })
    .where(and(eq(buildValidationSteps.buildId, buildId), eq(buildValidationSteps.key, key)));
}
