import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { AppException } from '../errors/app.exception';
import type { AuthUser } from '../auth/roles';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROCESSING_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 60 * 60 * 24; // replay window: 24h

/**
 * Auth endpoints mint per-request secrets (access tokens, refresh cookies)
 * and are called before any authenticated identity exists, so every caller
 * shares the same `anon` scope. Caching their responses would let anyone who
 * reuses (or guesses) an Idempotency-Key on these routes replay someone
 * else's tokens. Never cache them — always execute for real.
 */
const EXCLUDED_PATH_PREFIXES = ['/auth/'];

interface StoredResult {
  status: 'processing' | 'done';
  statusCode?: number;
  body?: unknown;
}

/** Recursively sorts object keys so semantically-identical payloads hash the same. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

function hashPayload(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body ?? {}))).digest('hex');
}

/**
 * Idempotency via the `Idempotency-Key` header, backed by Redis. Applies to
 * mutating requests that send the header — the first request runs; retries with
 * the same key replay the stored response instead of re-executing (so a page
 * reload can't create a duplicate test/checkout). A concurrent retry while the
 * first is still in flight gets a 409.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthUser }>();
    const response = http.getResponse<Response>();

    if (!MUTATION_METHODS.has(request.method)) return next.handle();
    if (EXCLUDED_PATH_PREFIXES.some((prefix) => request.path.startsWith(prefix))) {
      return next.handle();
    }

    const key = request.headers['idempotency-key'];
    if (!key || typeof key !== 'string') return next.handle();

    // Bind the cache slot to who's asking and exactly what they're asking for —
    // not just the method/URL/key — so the same key can never replay a
    // response minted for a different caller or a different payload.
    const scope = request.user?.userId ?? 'anon';
    const payloadHash = hashPayload(request.body);
    const redisKey = `idem:${scope}:${request.method}:${request.originalUrl}:${key}:${payloadHash}`;

    return from(this.redis.get(redisKey)).pipe(
      mergeMap((existingRaw) => {
        if (existingRaw) {
          const existing = JSON.parse(existingRaw) as StoredResult;
          if (existing.status === 'processing') {
            throw AppException.conflict('Requisição idêntica ainda em processamento');
          }
          if (existing.statusCode) response.status(existing.statusCode);
          return of(existing.body);
        }

        // Claim the key; if another request claimed it first, treat as in-flight.
        return from(
          this.redis.set(
            redisKey,
            JSON.stringify({ status: 'processing' } satisfies StoredResult),
            'EX',
            PROCESSING_TTL_SECONDS,
            'NX',
          ),
        ).pipe(
          mergeMap((claim) => {
            if (claim === null) {
              throw AppException.conflict('Requisição idêntica ainda em processamento');
            }
            return next.handle().pipe(
              mergeMap((body) =>
                from(
                  this.redis.set(
                    redisKey,
                    JSON.stringify({
                      status: 'done',
                      statusCode: response.statusCode,
                      body,
                    } satisfies StoredResult),
                    'EX',
                    RESULT_TTL_SECONDS,
                  ),
                ).pipe(mergeMap(() => of(body))),
              ),
              // On failure, release the claim so the client may legitimately retry.
              catchError((err) =>
                from(this.redis.del(redisKey)).pipe(mergeMap(() => throwError(() => err))),
              ),
            );
          }),
        );
      }),
    );
  }
}
