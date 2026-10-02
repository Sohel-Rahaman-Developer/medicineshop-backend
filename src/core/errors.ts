export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CSRF_INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'SUBSCRIPTION_REQUIRED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Extra info safe to show the client (field errors and the like). */
  readonly details?: unknown;
  readonly isOperational = true;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static validation(message = 'Some of the details are not valid', details?: unknown) {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }
  static unauthenticated(message = 'Please sign in to continue') {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have permission to do this') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  /** The client refetches /auth/csrf and retries once on this code. */
  static csrf(message = 'Your session check failed. Please try again.') {
    return new AppError(403, 'CSRF_INVALID', message);
  }
  static notFound(message = 'Not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
  static rateLimited(message = 'Too many requests. Please try again in a little while.') {
    return new AppError(429, 'RATE_LIMITED', message);
  }
  static subscriptionRequired(message = 'This feature needs an active subscription') {
    return new AppError(402, 'SUBSCRIPTION_REQUIRED', message);
  }
  static serviceUnavailable(message = 'This service is not available right now') {
    return new AppError(503, 'SERVICE_UNAVAILABLE', message);
  }
  static internal(message = 'Something went wrong') {
    return new AppError(500, 'INTERNAL', message);
  }
}
