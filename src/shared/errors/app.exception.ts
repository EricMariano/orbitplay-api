import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, type ErrorCodeValue } from './error-envelope';

/**
 * Domain-level exception carrying an explicit envelope code (and optional
 * fieldErrors). Prefer this over ad-hoc HttpExceptions when the front needs a
 * specific machine code. The global filter reads `code`/`fieldErrors` straight
 * from the response payload.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    code: ErrorCodeValue,
    message: string,
    fieldErrors?: Record<string, string>,
  ) {
    super({ code, message, fieldErrors }, status);
  }

  static notFound(message = 'Recurso não encontrado') {
    return new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, message);
  }

  static forbidden(message = 'Acesso negado') {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }

  static unauthorized(message = 'Não autenticado') {
    return new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED, message);
  }

  static conflict(message = 'Conflito de estado') {
    return new AppException(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message);
  }

  static validation(message = 'Dados inválidos', fieldErrors?: Record<string, string>) {
    return new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.VALIDATION_ERROR,
      message,
      fieldErrors,
    );
  }
}
