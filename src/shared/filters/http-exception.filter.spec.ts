import { Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter';

function httpHost() {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

/** Same shape as drizzle-orm's `DrizzleQueryError`: the params end up in the message. */
function failedQuery(params: unknown[], cause: Error) {
  const query = 'insert into "users" ("id", "email", "password_hash") values ($1, $2, $3)';
  return Object.assign(new Error(`Failed query: ${query}\nparams: ${params.join(',')}`), {
    query,
    params,
    cause,
  });
}

describe('HttpExceptionFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a failed query without its bound parameters', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, response } = httpHost();

    new HttpExceptionFilter().catch(
      failedQuery(
        ['01920000-0000-7000-8000-0000000000aa', 'pessoa@exemplo.com', '$argon2id$v=19$segredo'],
        new Error('canceling statement due to statement timeout'),
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('insert into');
    expect(logged).toContain('statement timeout');
    expect(logged).not.toContain('pessoa@exemplo.com');
    expect(logged).not.toContain('argon2id');
  });
});
