import type { Schema } from 'mongoose';

const QUERY_OPS = [
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'distinct',
] as const;

/** Throws when a query on a tenant collection has no shopId — a cross-shop leak can't happen by accident. */
export function tenantScoped(schema: Schema): void {
  for (const op of QUERY_OPS) {
    schema.pre(op, function () {
      if (this.getOptions().crossTenant === true) return;
      const filter = this.getFilter() as { shopId?: unknown };
      if (filter.shopId === undefined) throw new Error(`Tenant query without shopId on ${this.model.modelName}.${op}`);
    });
  }
  schema.pre('aggregate', function () {
    const first = this.pipeline()[0] as { $match?: { shopId?: unknown } } | undefined;
    if (first?.$match?.shopId === undefined) throw new Error('Tenant aggregate must start with $match on shopId');
  });
}

declare module 'mongoose' {
  interface QueryOptions {
    /** Only for queries that are deliberately per-user across shops (my memberships). */
    crossTenant?: boolean;
  }
}
