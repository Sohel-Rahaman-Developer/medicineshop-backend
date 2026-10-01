import type { Request } from 'express';

/** cookie-parser types cookies as `any`; read one as a non-empty string or nothing. */
export function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown>)[name];
  return typeof value === 'string' && value ? value : undefined;
}
