import { Types } from 'mongoose';
import { AppError } from './errors';

// Keyset pagination (PLAN §33.2): the sort value plus _id as the tie-breaker.
export interface SortSpec {
  field: string;
  dir: 1 | -1;
}

type Key = string | number | Date;

interface Encoded {
  v: string | number;
  d?: 1;
  id: string;
}

export function encodeCursor(value: Key, id: Types.ObjectId): string {
  const body: Encoded = value instanceof Date ? { v: value.getTime(), d: 1, id: String(id) } : { v: value, id: String(id) };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

function decode(cursor: string): { value: Key; id: Types.ObjectId } {
  try {
    const body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Encoded>;
    const v = body.v;
    if ((typeof v !== 'string' && typeof v !== 'number') || typeof body.id !== 'string' || !Types.ObjectId.isValid(body.id)) throw new Error('bad cursor');
    const value: Key = body.d === 1 && typeof v === 'number' ? new Date(v) : v;
    return { value, id: new Types.ObjectId(body.id) };
  } catch {
    throw AppError.badRequest('This list is out of date. Pull to refresh.');
  }
}

export function afterCursor(cursor: string | undefined, sort: SortSpec): Record<string, unknown> {
  if (!cursor) return {};
  const { value, id } = decode(cursor);
  const op = sort.dir === 1 ? '$gt' : '$lt';
  return { $or: [{ [sort.field]: { [op]: value } }, { [sort.field]: value, _id: { [op]: id } }] };
}

export const sortOf = (sort: SortSpec) => ({ [sort.field]: sort.dir, _id: sort.dir });

/** Reads `limit + 1` rows, returns `limit` and whether there is more. */
export function page<T extends { _id: Types.ObjectId }>(rows: T[], limit: number, keyOf: (row: T) => Key) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, meta: { hasMore, limit, nextCursor: hasMore && last ? encodeCursor(keyOf(last), last._id) : null } };
}
