/** Optimistic-concurrency counter of a hydrated document (versionKey: 'version'). */
export const versionOf = (doc: { get(path: string): unknown }): number => Number(doc.get('version') ?? 0);
