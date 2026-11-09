import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  contentTypeFor,
  extractWebBuild,
  inspectWebBuild,
  normalizeWebPath,
  PLAY_LINK_TTL_SECONDS,
  signPlayToken,
  verifyPlayToken,
  WEB_BUILD_MAX_FILES,
} from './web-build';

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

describe('normalizeWebPath', () => {
  it.each([
    ['index.html', 'index.html'],
    ['./assets//app.js', 'assets/app.js'],
    ['a/./b/c.png', 'a/b/c.png'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeWebPath(raw)).toBe(expected);
  });

  it.each(['../secret', 'a/../../b', '/etc/passwd', 'C:/win.ini', 'a\\b.js', 'a\0b', '', './'])(
    'rejects %j',
    (raw) => {
      expect(normalizeWebPath(raw)).toBeNull();
    },
  );
});

describe('inspectWebBuild', () => {
  it('accepts index.html at the root', () => {
    expect(inspectWebBuild(zip({ 'index.html': '<html>', 'a.js': '' }))).toMatchObject({
      ok: true,
      fileCount: 2,
      root: '',
    });
  });

  it('accepts index.html inside a single top-level folder', () => {
    expect(inspectWebBuild(zip({ 'game/index.html': '', 'game/a.js': '' }))).toMatchObject({
      ok: true,
      root: 'game/',
    });
  });

  it('rejects a zip without an index.html to open', () => {
    expect(inspectWebBuild(zip({ 'a/index.html': '', 'b/x.js': '' }))).toMatchObject({ ok: false });
    expect(inspectWebBuild(zip({ 'game.exe': '' }))).toMatchObject({ ok: false });
  });

  it('rejects entries that would escape the build folder', () => {
    expect(inspectWebBuild(zip({ 'index.html': '', '../../evil.js': '' }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('caminhos inválidos'),
    });
  });

  it('rejects bytes that are not a zip', () => {
    expect(inspectWebBuild(strToU8('PK\u0003\u0004 not really a zip'))).toMatchObject({
      ok: false,
    });
  });

  it('rejects too many files', () => {
    const files: Record<string, string> = { 'index.html': '' };
    for (let i = 0; i < WEB_BUILD_MAX_FILES; i++) files[`f${i}.js`] = '';
    expect(inspectWebBuild(zip(files))).toMatchObject({ ok: false });
  });
});

describe('extractWebBuild', () => {
  it('returns the files re-rooted, without junk or folders', () => {
    const files = extractWebBuild(
      zip({ 'g/index.html': 'hi', 'g/js/a.js': 'x', 'g/.DS_Store': '', '__MACOSX/g/._a': '' }),
      'g/',
    );
    expect(files.map((f) => f.path).sort()).toEqual(['index.html', 'js/a.js']);
    expect(Buffer.from(files.find((f) => f.path === 'index.html')!.bytes).toString()).toBe('hi');
  });
});

describe('contentTypeFor', () => {
  it('maps common web assets and falls back to octet-stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('game.WASM')).toBe('application/wasm');
    expect(contentTypeFor('data.bin')).toBe('application/octet-stream');
  });
});

describe('play tokens', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);

  it('round-trips for the same build until it expires', () => {
    const { token, expiresAt } = signPlayToken('s3cret', 'build-1', now);
    expect(expiresAt.getTime()).toBe(now + PLAY_LINK_TTL_SECONDS * 1000);
    expect(verifyPlayToken('s3cret', 'build-1', token, now + 1000)).toBe(true);
    expect(verifyPlayToken('s3cret', 'build-1', token, expiresAt.getTime())).toBe(false);
  });

  it('does not verify for another build, secret, or a tampered expiry', () => {
    const { token } = signPlayToken('s3cret', 'build-1', now);
    expect(verifyPlayToken('s3cret', 'build-2', token, now)).toBe(false);
    expect(verifyPlayToken('other', 'build-1', token, now)).toBe(false);
    const [exp, sig] = token.split('.');
    expect(verifyPlayToken('s3cret', 'build-1', `${Number(exp) + 3600}.${sig}`, now)).toBe(false);
  });
});
