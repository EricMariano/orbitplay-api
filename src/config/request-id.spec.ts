import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './request-id';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['01a0f3c2-7b1d-7c00-9e3a-000000000001', 'abc.DEF_123-x', 'a', 'x'.repeat(128)])(
    'keeps a well-formed client id (%s)',
    (id) => {
      expect(resolveRequestId(id)).toBe(id);
    },
  );

  it('takes the first value of a repeated header', () => {
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'x'.repeat(129)],
    ['spaces', 'two words'],
    ['CRLF (log forging)', 'ok\r\n{"level":"error","msg":"forged"}'],
    ['markup', '<script>alert(1)</script>'],
    ['non-ASCII', 'requisição'],
  ])('generates a UUIDv7 instead of a %s id', (_label, header) => {
    const id = resolveRequestId(header);
    expect(id).toMatch(UUID_V7);
    expect(id).not.toBe(header);
  });
});
