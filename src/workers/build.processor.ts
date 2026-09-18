import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { buildValidationSteps, builds } from '../infra/database/schema/tests';
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
 * Real validation pipeline: HEAD confirms the object landed in storage, then
 * the object's actual bytes are streamed server-side to compute a SHA-256
 * checksum and sniff the format's magic bytes — neither trusts anything the
 * client claimed at upload time. There is no malware scanner integrated yet,
 * so that step always fails closed: a build can never be auto-approved for a
 * scan that never ran. `plugin_manifest` is a reserved future step
 * (ORB-M6-02 scope) and is never instantiated here.
 */
export async function processBuildValidate(deps: WorkerDeps, buildId: string): Promise<void> {
  const rows = await deps.db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
  const build = rows[0];
  if (!build) throw new Error(`build ${buildId} not found`);

  const meta = await deps.storage.stat(build.storageKey);
  if (!meta) {
    await fail(deps, buildId, 'checksum', 'Arquivo não encontrado no storage');
    return;
  }

  let hashed: { sha256: string; headBytes: Buffer };
  try {
    hashed = await hashObject(deps, build.storageKey);
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

  // No AV/malware scanner is integrated in this environment. Fail closed
  // rather than pretend a scan happened — the build stays blocked until a
  // real scanner is wired in (or a human clears it through manual review).
  await fail(
    deps,
    buildId,
    'malware_scan',
    'Verificação de malware indisponível: nenhum scanner integrado ainda',
  );
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
