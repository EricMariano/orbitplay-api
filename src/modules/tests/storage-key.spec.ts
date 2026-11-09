import { describe, expect, it } from 'vitest';
import {
  buildBuildStorageKey,
  buildObjectKeys,
  parseBuildStorageKey,
  validatedBuildStorageKey,
} from './storage-key';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const TEST = '01990000-0000-7000-8000-0000000000d1';
const BUILD = '01990000-0000-7000-8000-0000000000b1';

describe('parseBuildStorageKey', () => {
  it('round-trips a key built by the API, file name included', () => {
    const key = buildBuildStorageKey(ORG, TEST, BUILD, 'meu jogo%.zip');
    expect(parseBuildStorageKey(key)).toEqual({
      organizationId: ORG,
      testId: TEST,
      buildId: BUILD,
      fileName: 'meu jogo%.zip',
    });
  });

  it('refuses a malformed escape instead of throwing a URIError', () => {
    expect(parseBuildStorageKey(`orgs/${ORG}/tests/${TEST}/builds/${BUILD}/%`)).toBeNull();
  });
});

describe('validated copy key', () => {
  it('is never confirmable: a raw `/` in the file-name segment is refused', () => {
    expect(parseBuildStorageKey(validatedBuildStorageKey(ORG, TEST, BUILD, 'game.zip'))).toBeNull();
    expect(parseBuildStorageKey(`orgs/${ORG}/tests/${TEST}/builds/${BUILD}/a/b.zip`)).toBeNull();
  });

  it('still accepts a file name whose `/` came encoded, as the API issues it', () => {
    const key = buildBuildStorageKey(ORG, TEST, BUILD, 'pasta/game.zip');
    expect(key.endsWith('/pasta%2Fgame.zip')).toBe(true);
    expect(parseBuildStorageKey(key)?.fileName).toBe('pasta/game.zip');
  });
});

describe('buildObjectKeys', () => {
  const base = { id: BUILD, organizationId: ORG, testId: TEST, fileName: 'game.zip' };
  const upload = buildBuildStorageKey(ORG, TEST, BUILD, 'game.zip');
  const copy = validatedBuildStorageKey(ORG, TEST, BUILD, 'game.zip');

  it('lists the upload and the validated copy once each, whichever the row points at', () => {
    expect(buildObjectKeys({ ...base, storageKey: upload })).toEqual([upload, copy]);
    expect(buildObjectKeys({ ...base, storageKey: copy }).sort()).toEqual([upload, copy].sort());
  });

  it('keeps a row key that is neither (rows written before the copy existed)', () => {
    expect(buildObjectKeys({ ...base, storageKey: 'legacy/key.zip' })).toEqual([
      'legacy/key.zip',
      upload,
      copy,
    ]);
  });
});
