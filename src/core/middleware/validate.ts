/**
 * Zod validation middleware.
 *
 * Rule: never hand-roll `if (!req.body.email)` inside a controller. Declare the
 * schema here and the controller receives validated, typed data — and bad
 * input always produces the same 422 response.
 */
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../errors';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export const validate = (schemas: Schemas): RequestHandler => {
  return (req, _res, next) => {
    const issues: { field: string; message: string }[] = [];

    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (result.success) {
        // Write the parsed value back — that is the only way coercion and
        // defaults reach the controller. In Express 4 `req.query` is writable.
        Object.defineProperty(req, key, { value: result.data, writable: true, configurable: true });
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            field: [key, ...issue.path.map(String)].filter(Boolean).join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (issues.length) return next(AppError.validation('Some of the details are not valid', issues));
    next();
  };
};
