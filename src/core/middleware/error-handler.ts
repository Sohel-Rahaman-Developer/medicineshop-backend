import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from '../errors';
import { logger } from '../../config/logger';
import { isProd } from '../../config/env';

// body-parser marks its own errors with `type`.
const bodyParserType = (err: unknown) => (err as { type?: unknown } | null)?.type;

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (thrown, req, res, _next) => {
  const err: unknown = thrown;
  let status = 500;
  let code: ErrorCode = 'INTERNAL';
  let message = 'Something went wrong';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Some of the details are not valid';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Data validation failed';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'BAD_REQUEST';
    message = `Invalid ${err.path} value`;
  } else if (bodyParserType(err) === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'That request is too large';
  } else if (bodyParserType(err) === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_REQUEST';
    message = 'The request body is not valid JSON';
  } else if ((err as { code?: number }).code === 11000) {
    status = 409;
    code = 'CONFLICT';
    const key = Object.keys((err as { keyValue?: Record<string, unknown> }).keyValue ?? {})[0];
    message = key ? `This ${key} already exists` : 'Duplicate record';
  }

  const log = { err, status, code, method: req.method, url: req.originalUrl };
  if (status >= 500) logger.error(log, 'Request failed');
  else logger.warn(log, 'Request rejected');

  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      // Stack traces in development only — never in production.
      ...(!isProd && status >= 500 ? { stack: (err as Error).stack } : {}),
    },
  });
};
