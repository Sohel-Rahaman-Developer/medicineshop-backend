/**
 * Global error handler — har error yahin se response banta hai.
 *
 * Security: internal errors ka message client ko NAHI bhejte (stack trace,
 * mongo error text waghairah leak ho sakta hai). Client ko generic message
 * jaata hai, poora error sirf server log me.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { logger } from '../../config/logger';
import { isProd } from '../../config/env';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route nahi mila: ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL';
  let message = 'Kuch galat ho gaya';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Bheji hui details sahi nahi hain';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Data validation fail hua';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'BAD_REQUEST';
    message = `Galat ${err.path} value`;
  } else if ((err as { code?: number }).code === 11000) {
    // duplicate key
    status = 409;
    code = 'CONFLICT';
    const key = Object.keys((err as { keyValue?: Record<string, unknown> }).keyValue ?? {})[0];
    message = key ? `Ye ${key} pehle se maujood hai` : 'Duplicate record';
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
      // Stack sirf dev me — production me kabhi nahi.
      ...(!isProd && status >= 500 ? { stack: (err as Error).stack } : {}),
    },
  });
};
