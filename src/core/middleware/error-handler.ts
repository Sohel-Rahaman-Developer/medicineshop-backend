/**
 * Global error handler — every error response is built here.
 *
 * Security: internal errors never send their real message to the client (it
 * can leak stack traces, Mongo error text and so on). The client gets a
 * generic message; the full error goes to the server log only.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { logger } from '../../config/logger';
import { isProd } from '../../config/env';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL';
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
  } else if ((err as { code?: number }).code === 11000) {
    // duplicate key
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
