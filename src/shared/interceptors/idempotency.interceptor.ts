import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { AppException } from '../errors/app.exception';
import type { AuthUser } from '../auth/roles';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROCESSING_TTL_SECONDS = 60;
const RESULT_TTL_SECONDS = 60 * 60 * 24; // replay window: 24h

interface StoredResult {
  status: 'processing' | 'done';
  statusCode?: number;
  body?: unknown;
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

    const key = request.headers['idempotency-key'];
    if (!key || typeof key !== 'string') return next.handle();

    const scope = request.user?.userId ?? 'anon';
    const redisKey = `idem:${scope}:${request.method}:${request.originalUrl}:${key}`;

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
