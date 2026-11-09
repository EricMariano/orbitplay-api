import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './request-id';

const generate = () => 'generated-id-0001';

describe('resolveRequestId', () => {
  it('reaproveita um id bem formado enviado pelo cliente', () => {
    expect(resolveRequestId('01a0b2c4-d5e6-7f80-9a1b-2c3d4e5f6a7b', generate)).toBe(
      '01a0b2c4-d5e6-7f80-9a1b-2c3d4e5f6a7b',
    );
  });

  it('usa o primeiro valor quando o header chega repetido', () => {
    expect(resolveRequestId(['first-request-id', 'second-request-id'], generate)).toBe(
      'first-request-id',
    );
  });

  it('gera um id novo quando não há header', () => {
    expect(resolveRequestId(undefined, generate)).toBe('generated-id-0001');
  });

  it.each([
    ['vazio', ''],
    ['curto demais', 'abc'],
    ['grande demais', 'a'.repeat(129)],
    ['com espaço', 'abc def ghi jkl'],
    ['com quebra de linha (forja de log)', 'abcdefgh\n{"level":"error"}'],
    ['com caracteres de controle', 'abcdefgh\u0000\u001b[31m'],
  ])('descarta um id %s', (_label, value) => {
    expect(resolveRequestId(value, generate)).toBe('generated-id-0001');
  });
});
