import { describe, expect, it } from 'vitest';
import { isConnectivityError } from './connectivity-error';

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isConnectivityError', () => {
  it.each(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'ECONNREFUSED', '57P03', '08006'])(
    'recognizes code %s',
    (code) => {
      expect(isConnectivityError(withCode(code))).toBe(true);
    },
  );

  it('looks through the cause chain (DrizzleQueryError -> driver error)', () => {
    const wrapped = new Error('Failed query: select 1', { cause: withCode('ECONNREFUSED') });
    expect(isConnectivityError(wrapped)).toBe(true);
  });

  it('recognizes ioredis give-up and command-timeout errors', () => {
    const maxRetries = new Error('Reached the max retries per request limit');
    maxRetries.name = 'MaxRetriesPerRequestError';
    expect(isConnectivityError(maxRetries)).toBe(true);
    expect(isConnectivityError(new Error('Command timed out'))).toBe(true);
  });

  it('treats a dependency timeout (TimeoutError) as connectivity', () => {
    const timeout = new Error('BullMQ enqueue timed out after 5000ms');
    timeout.name = 'TimeoutError';
    expect(isConnectivityError(timeout)).toBe(true);
  });

  it('does not flag ordinary query/domain errors', () => {
    expect(isConnectivityError(withCode('23505', 'duplicate key'))).toBe(false); // unique_violation
    expect(isConnectivityError(withCode('42P01', 'relation does not exist'))).toBe(false);
    expect(isConnectivityError(new Error('anything else'))).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
    expect(isConnectivityError('ECONNREFUSED')).toBe(false);
  });

  it('terminates on circular cause chains', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isConnectivityError(a)).toBe(false);
  });
});
