import { describe, expect, it } from 'vitest';
import { buildBuildStorageKey, parseBuildStorageKey } from './storage-key';

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
