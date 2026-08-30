import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';
import { codeForStatus, ErrorCode, type ErrorEnvelope } from '../errors/error-envelope';

/**
 * The ONLY place API errors are serialized. Every thrown exception — framework,
 * validation, domain — is normalized into the single {@link ErrorEnvelope}.
 * No controller assembles an error response by hand.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    const envelope = this.toEnvelope(exception, requestId);

    if (envelope.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Log the real cause server-side; never leak internals to the client.
      this.logger.error(
        `Unhandled error [${requestId}]: ${this.describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(envelope.statusCode).json(envelope);
  }

  private toEnvelope(exception: unknown, requestId: string): ErrorEnvelope {
    // 1) Zod validation → 422 with per-field errors.
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as ZodError;
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Dados inválidos',
        fieldErrors: this.fieldErrorsFromZod(zodError),
        requestId,
      };
    }

    // 2) Rate limiting → 429.
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.TOO_MANY_REQUESTS,
        message: 'Muitas tentativas. Tente novamente em instantes.',
        requestId,
      };
    }

    // 3) Any HttpException (incl. AppException and Nest built-ins).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      return this.fromHttpException(status, res, requestId);
    }

    // 4) Anything else → opaque 500.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Erro interno do servidor',
      requestId,
    };
  }

  private fromHttpException(
    status: number,
    res: string | object,
    requestId: string,
  ): ErrorEnvelope {
    if (typeof res === 'string') {
      return { statusCode: status, code: codeForStatus(status), message: res, requestId };
    }

    const payload = res as {
      code?: string;
      message?: string | string[];
      fieldErrors?: Record<string, string>;
    };
    const message = Array.isArray(payload.message)
      ? payload.message.join(', ')
      : (payload.message ?? 'Erro');

    return {
      statusCode: status,
      code: payload.code ?? codeForStatus(status),
      message,
      ...(payload.fieldErrors ? { fieldErrors: payload.fieldErrors } : {}),
      requestId,
    };
  }

  private fieldErrorsFromZod(error: ZodError): Record<string, string> {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.length ? issue.path.join('.') : '_';
      // First message per field wins — keeps the front's inline errors stable.
      if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
    }
    return fieldErrors;
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
    return String(exception);
  }
}
