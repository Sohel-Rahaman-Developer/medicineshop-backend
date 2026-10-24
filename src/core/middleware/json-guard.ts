import type { RequestHandler } from 'express';
import { AppError } from '../errors';

const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** True when parsed JSON carries `__proto__` or `constructor.prototype` anywhere — never real data, only an attack. */
export function poisoned(body: unknown): boolean {
  // A loop, not recursion: a 5,000-deep body must not blow the stack.
  const stack: unknown[] = [body];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (own(v, '__proto__')) return true;
    const ctor: unknown = own(v, 'constructor') ? (v as Record<string, unknown>).constructor : undefined;
    if (ctor && typeof ctor === 'object' && own(ctor, 'prototype')) return true;
    for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key]);
  }
  return false;
}

/** zod's strict objects let a `__proto__` key through unnoticed; such a body never reaches a route. */
export const jsonGuard: RequestHandler = (req, _res, next) => {
  next(poisoned(req.body) ? AppError.badRequest('This request is not allowed') : undefined);
};
