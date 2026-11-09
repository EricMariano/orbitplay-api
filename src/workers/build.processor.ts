import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { buildValidationSteps, builds, type BuildRow } from '../infra/database/schema/tests';
import { validatedBuildStorageKey } from '../modules/tests/storage-key';
import type { ScanResult } from '../shared/ports/malware-scanner.port';
import type { StorageObjectMeta } from '../shared/ports/storage.port';
import type { WorkerDeps } from './deps';

type BuildStepKey = 'checksum' | 'malware_scan' | 'metadata';

const HEAD_BYTES = 8;

/**
 * Magic-byte signatures for the container formats we can confidently
 * recognize, keyed by file extension. An extension outside this table fails
 * closed instead of being guessed at — we'd rather block an unrecognized
 * build than wave it through.
 */
const FORMAT_SIGNATURES: Record<string, readonly number[]> = {
  apk: [0x50, 0x4b, 0x03, 0x04], // zip
  ipa: [0x50, 0x4b, 0x03, 0x04], // zip
  zip: [0x50, 0x4b, 0x03, 0x04],
  exe: [0x4d, 0x5a], // PE/MZ
  msi: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE compound file
  deb: [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e], // ar "!<arch>"
  appimage: [0x7f, 0x45, 0x4c, 0x46], // ELF
  pkg: [0x78, 0x61, 0x72, 0x21], // xar "xar!"
  gz: [0x1f, 0x8b],
  tgz: [0x1f, 0x8b],
};

/**
 * Real validation pipeline: the upload is first copied server-side to an
 * immutable key no presigned URL was ever issued for
 * (`validatedBuildStorageKey`), and everything after that reads THE COPY —
 * the upload URL stays valid for an hour, so validating (and later serving)
 * the upload key itself let a studio re-PUT other bytes behind an already
 * `validated` badge, or between the checksum read and the scan read. The
 * copy's bytes are streamed to compute a SHA-256 checksum and sniff the
 * format's magic bytes — neither trusts anything the client claimed at upload
 * time — and then to the malware scanner (ClamAV via clamd). Only a `clean`
 * verdict validates the build, and that same write points `storage_key` at
 * the copy; the upload object is removed afterwards. A scan that could not
 * finish is retried, never waved through. The dev bypass swaps in a scanner
 * that reports `skipped` (never `clean`); `buildConfig` refuses it in
 * production.
 * `plugin_manifest` is a reserved future step
 * (ORB-M6-02 scope) and is never instantiated here.
 */
export async function processBuildValidate(deps: WorkerDeps, buildId: string): Promise<void> {
  const rows = await deps.db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
  const build = rows[0];
  if (!build) throw new Error(`build ${buildId} not found`);

  const validatedKey = validatedBuildStorageKey(
    build.organizationId,
    build.testId,
    build.id,
    build.fileName,
  );
  // Redelivered after an earlier run already approved it: the row already
  // serves the validated copy, so there is nothing left to check.
  if (build.status === 'validated' && build.storageKey === validatedKey) return;

  let meta: StorageObjectMeta | null;
  try {
    meta = await ensureValidatedCopy(deps, build.storageKey, validatedKey);
  } catch (err) {
    await fail(deps, buildId, 'checksum', `Falha ao copiar objeto para validação: ${String(err)}`);
    return;
  }
  if (!meta) {
    await fail(deps, buildId, 'checksum', 'Arquivo não encontrado no storage');
    return;
  }

  let hashed: { sha256: string; headBytes: Buffer };
  try {
    hashed = await hashObject(deps, validatedKey);
  } catch (err) {
    await fail(deps, buildId, 'checksum', `Falha ao ler objeto para checksum: ${String(err)}`);
    return;
  }

  if (build.checksum && build.checksum.toLowerCase() !== hashed.sha256.toLowerCase()) {
    await fail(
      deps,
      buildId,
      'checksum',
      'Checksum declarado não confere com o checksum calculado no servidor',
    );
    return;
  }
  await setStep(
    deps,
    buildId,
    'checksum',
    'ready',
    `SHA-256 calculado no servidor: ${hashed.sha256}`,
  );
  await deps.db.update(builds).set({ checksum: hashed.sha256 }).where(eq(builds.id, buildId));

  const ext = extensionOf(build.fileName);
  const signature = ext ? FORMAT_SIGNATURES[ext] : undefined;
  if (
    !signature ||
    !hashed.headBytes.subarray(0, signature.length).equals(Buffer.from(signature))
  ) {
    await fail(
      deps,
      buildId,
      'metadata',
      'Formato do arquivo não reconhecido ou não corresponde à extensão declarada',
    );
    return;
  }
  await setStep(
    deps,
    buildId,
    'metadata',
    'ready',
    `Formato .${ext} confirmado por assinatura binária`,
  );

  let scan: ScanResult;
  try {
    scan = await deps.scanner.scan(
      await deps.storage.getObjectStream(validatedKey),
      meta.sizeBytes,
    );
  } catch (err) {
    scan = { verdict: 'error', reason: `Falha ao ler objeto para verificação: ${String(err)}` };
  }

  switch (scan.verdict) {
    case 'clean':
      await recordScan(deps, buildId, scan.engine, scan.signatures);
      await setStep(
        deps,
        buildId,
        'malware_scan',
        'ready',
        `Nenhuma ameaça encontrada (${scan.engine}, assinaturas ${scan.signatures})`,
      );
      await approve(deps, build, validatedKey, meta.sizeBytes);
      return;
    case 'skipped':
      await setStep(
        deps,
        buildId,
        'malware_scan',
        'ready',
        'Verificação de malware PULADA (BUILD_MALWARE_SCAN_BYPASS, só em desenvolvimento)',
      );
      await approve(deps, build, validatedKey, meta.sizeBytes);
      return;
    case 'infected':
      await recordScan(deps, buildId, scan.engine, scan.signatures);
      await fail(deps, buildId, 'malware_scan', `Ameaça detectada: ${scan.threat}`);
      return;
    case 'unscannable':
      await recordScan(deps, buildId, scan.engine, scan.signatures);
      await fail(
        deps,
        buildId,
        'malware_scan',
        `Verificação de malware não concluída: ${scan.reason}`,
      );
      return;
    case 'error':
      // Transient (scanner down, timeout): leave the build `processing` and throw so the
      // job fails; the reconciliation sweep re-enqueues it up to MAX_JOB_RUNS times and then
      // settles the build as failed. A build is never approved for a scan that did not finish.
      throw new Error(`Verificação de malware indisponível: ${scan.reason}`);
  }
}

/**
 * Copy-once: the validated key is written a single time, from whatever the
 * upload holds at that moment, and from then on only read. A redelivered job
 * (stalled lock, retry after a scanner outage) reuses the existing copy
 * instead of copying again — a second copy could swap the bytes under a run
 * still scanning them, or under a build an earlier run already approved. The
 * only window left is two deliveries racing on the very first copy, and a
 * stalled job is only redelivered once its lock expires, long after a copy
 * completes. `null` when there is nothing to validate.
 */
async function ensureValidatedCopy(
  deps: WorkerDeps,
  sourceKey: string,
  validatedKey: string,
): Promise<StorageObjectMeta | null> {
  const existing = await deps.storage.stat(validatedKey);
  if (existing) return existing;
  if (sourceKey === validatedKey) return null;
  if (!(await deps.storage.stat(sourceKey))) return null;
  await deps.storage.copyObject(sourceKey, validatedKey);
  return deps.storage.stat(validatedKey);
}

/**
 * Approves the build and points the row at the validated copy in the same
 * write, so a `validated` build never serves the mutable upload key. The
 * upload object goes afterwards (best-effort, like every storage cleanup):
 * nothing reads it anymore. A row deleted mid-run (`DELETE /tests/:id/build`)
 * leaves nobody to clean the copy up later, so it goes too.
 */
async function approve(
  deps: WorkerDeps,
  build: BuildRow,
  validatedKey: string,
  sizeBytes: number,
): Promise<void> {
  const updated = await deps.db
    .update(builds)
    .set({ status: 'validated', failureReason: null, storageKey: validatedKey, sizeBytes })
    .where(eq(builds.id, build.id))
    .returning({ id: builds.id });
  if (build.storageKey !== validatedKey) {
    await deps.storage.remove(build.storageKey).catch(() => undefined);
  }
  if (updated.length === 0) {
    await deps.storage.remove(validatedKey).catch(() => undefined);
  }
}

async function recordScan(
  deps: WorkerDeps,
  buildId: string,
  engine: string,
  signatures: string,
): Promise<void> {
  await deps.db
    .update(builds)
    .set({ scanEngine: engine, scanSignatures: signatures, scanFinishedAt: new Date() })
    .where(eq(builds.id, buildId));
}

/** Streams the object once, hashing every byte and capturing the leading bytes for format sniffing. */
async function hashObject(
  deps: WorkerDeps,
  storageKey: string,
): Promise<{ sha256: string; headBytes: Buffer }> {
  const stream = await deps.storage.getObjectStream(storageKey);
  const hash = createHash('sha256');
  const headChunks: Buffer[] = [];
  let headLen = 0;

  for await (const chunk of stream) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    if (headLen < HEAD_BYTES) {
      headChunks.push(buf.subarray(0, HEAD_BYTES - headLen));
      headLen += buf.length;
    }
  }

  return { sha256: hash.digest('hex'), headBytes: Buffer.concat(headChunks) };
}

function extensionOf(fileName: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : null;
}

async function fail(
  deps: WorkerDeps,
  buildId: string,
  step: BuildStepKey,
  reason: string,
): Promise<void> {
  await setStep(deps, buildId, step, 'failed', reason);
  await deps.db
    .update(builds)
    .set({ status: 'failed', failureReason: reason })
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
