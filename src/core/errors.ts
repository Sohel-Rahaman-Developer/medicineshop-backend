/**
 * Application errors.
 *
 * Rule: service layer `AppError` throw karega, controller usse catch nahi
 * karega — global error handler use response me convert karega. Isse har
 * endpoint ka error shape same rehta hai.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SUBSCRIPTION_REQUIRED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Client ko dikhane layak extra info (field errors waghairah). */
  readonly details?: unknown;
  /** Expected error hai (business rule), ya genuine bug? */
  readonly isOperational = true;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static validation(message = 'Bheji hui details sahi nahi hain', details?: unknown) {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }
  static unauthenticated(message = 'Login zaroori hai') {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'Is kaam ki permission nahi hai') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Record nahi mila') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
  static rateLimited(message = 'Bahut zyada requests. Thodi der baad try karo.') {
    return new AppError(429, 'RATE_LIMITED', message);
  }
  static subscriptionRequired(message = 'Is feature ke liye active subscription chahiye') {
    return new AppError(402, 'SUBSCRIPTION_REQUIRED', message);
  }
  static internal(message = 'Kuch galat ho gaya') {
    return new AppError(500, 'INTERNAL', message);
  }
}
