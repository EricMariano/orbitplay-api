import { createHmac, timingSafeEqual } from 'node:crypto';
import { unzipSync } from 'fflate';

/**
 * Web builds (`platform: 'web'`, `.zip`) run inside the player's browser: on
 * validation the worker unpacks them under `webBuildPrefix` and the API serves
 * those files to a sandboxed iframe (`GET /builds/:id/play/:token/*path`).
 * Everything here is pure so the worker, the service and the specs share it.
 */

/** A web zip bigger than this is still a valid download, just not playable in the browser. */
export const WEB_BUILD_MAX_ZIP_BYTES = 200 * 1024 * 1024;
/** Sum of the declared uncompressed sizes — the guard against zip bombs. */
export const WEB_BUILD_MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
export const WEB_BUILD_MAX_FILES = 5_000;
export const WEB_BUILD_ENTRY_FILE = 'index.html';

/** How long a play link stays valid — long enough for one gameplay session. */
export const PLAY_LINK_TTL_SECONDS = 4 * 60 * 60;

export interface WebBuildFile {
  /** Normalized path relative to the build root (`assets/app.js`). */
  path: string;
  bytes: Uint8Array;
}

export type WebBuildInspection =
  | { ok: true; fileCount: number; unpackedBytes: number; root: string }
  | { ok: false; reason: string };

/**
 * Normalizes a path from a zip entry or a request URL: forward slashes, no
 * empty/`.` segments, and anything that could climb out of the build root
 * (`..`, absolute paths, drive letters, NUL) rejected outright — `null`.
 */
export function normalizeWebPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\')) return null;
  if (raw.startsWith('/') || /^[a-z]:/i.test(raw)) return null;
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) return null;
  return segments.join('/');
}

/** OS junk that zip tools add and nobody serves. */
function isJunk(path: string): boolean {
  return path.startsWith('__MACOSX/') || path.split('/').some((s) => s === '.DS_Store');
}

interface EntryMeta {
  path: string;
  originalSize: number;
}

/**
 * Reads only the zip's directory (no inflating) and decides where the build
 * root is: `index.html` at the top, or inside a single top-level folder (what
 * "compress this folder" produces). Enforces the file-count and unpacked-size
 * limits on the declared sizes before anything is decompressed.
 */
export function inspectWebBuild(zip: Uint8Array): WebBuildInspection {
  if (zip.length > WEB_BUILD_MAX_ZIP_BYTES) {
    return { ok: false, reason: 'Build web grande demais para rodar no navegador (máx. 200 MB)' };
  }
  const entries: EntryMeta[] = [];
  let unsafe = false;
  try {
    unzipSync(zip, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false;
        const path = normalizeWebPath(file.name);
        if (!path) {
          unsafe = true;
          return false;
        }
        if (!isJunk(path)) entries.push({ path, originalSize: file.originalSize });
        return false;
      },
    });
  } catch {
    return { ok: false, reason: 'Arquivo .zip corrompido ou ilegível' };
  }
  if (unsafe) {
    return { ok: false, reason: 'O .zip contém caminhos inválidos (ex.: "../")' };
  }
  if (entries.length > WEB_BUILD_MAX_FILES) {
    return { ok: false, reason: `Build web com arquivos demais (máx. ${WEB_BUILD_MAX_FILES})` };
  }
  const unpackedBytes = entries.reduce((sum, e) => sum + e.originalSize, 0);
  if (unpackedBytes > WEB_BUILD_MAX_UNPACKED_BYTES) {
    return { ok: false, reason: 'Build web grande demais depois de descompactada (máx. 500 MB)' };
  }
  const root = findRoot(entries.map((e) => e.path));
  if (root === null) {
    return {
      ok: false,
      reason: 'Build web precisa de um index.html na raiz do .zip (ou numa única pasta)',
    };
  }
  return { ok: true, fileCount: entries.length, unpackedBytes, root };
}

function findRoot(paths: string[]): string | null {
  if (paths.includes(WEB_BUILD_ENTRY_FILE)) return '';
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  if (tops.size !== 1) return null;
  const [top] = tops;
  return paths.includes(`${top}/${WEB_BUILD_ENTRY_FILE}`) ? `${top}/` : null;
}

/**
 * Inflates the files `inspectWebBuild` approved, re-rooted so `index.html`
 * sits at the top. Only call it after a successful inspection: the size
 * limits were checked there, on the same bytes.
 */
export function extractWebBuild(zip: Uint8Array, root: string): WebBuildFile[] {
  const unpacked = unzipSync(zip, {
    filter: (file) => {
      if (file.name.endsWith('/')) return false;
      const path = normalizeWebPath(file.name);
      return path !== null && !isJunk(path) && path.startsWith(root);
    },
  });
  const files: WebBuildFile[] = [];
  for (const [name, bytes] of Object.entries(unpacked)) {
    const path = normalizeWebPath(name);
    if (!path) continue;
    const relative = path.slice(root.length);
    if (relative) files.push({ path: relative, bytes });
  }
  return files;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

export function contentTypeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}

function playSignature(secret: string, buildId: string, expiresAtSec: number): string {
  // Domain-separated from the JWTs signed with the same secret.
  return createHmac('sha256', secret)
    .update(`orbitplay:build-play:${buildId}:${expiresAtSec}`)
    .digest('base64url');
}

/**
 * The token lives in the URL path (`/builds/:id/play/<token>/index.html`), so
 * every relative asset the game loads carries it too — an iframe can't send
 * an `Authorization` header. Format: `<expiresAtSec>.<hmac>`.
 */
export function signPlayToken(
  secret: string,
  buildId: string,
  nowMs: number = Date.now(),
): { token: string; expiresAt: Date } {
  const expiresAtSec = Math.floor(nowMs / 1000) + PLAY_LINK_TTL_SECONDS;
  return {
    token: `${expiresAtSec}.${playSignature(secret, buildId, expiresAtSec)}`,
    expiresAt: new Date(expiresAtSec * 1000),
  };
}

export function verifyPlayToken(
  secret: string,
  buildId: string,
  token: string,
  nowMs: number = Date.now(),
): boolean {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{1,128})$/.exec(token);
  if (!match) return false;
  const expiresAtSec = Number(match[1]);
  if (expiresAtSec * 1000 <= nowMs) return false;
  const expected = Buffer.from(playSignature(secret, buildId, expiresAtSec));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
