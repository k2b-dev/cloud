/** Field types whose stored value the search matches as text. */
export const SCALAR_SEARCH_TYPES = new Set(["text", "longtext", "id", "number", "percent", "duration", "date", "boolean"]);

/** Field types whose option labels the search matches. */
export const SELECT_SEARCH_TYPES = new Set(["select"]);

/**
 * Searchable fields = fields with a stable SQL-side text or label
 * projection. This drives the records search scope and its validation;
 * compileSearchClause remains the authoritative backend implementation.
 */
export const filterSearchableFields = <F extends { type: string; deletedAt: string | null }>(fields: F[]): F[] =>
  fields.filter((f) => !f.deletedAt && (SCALAR_SEARCH_TYPES.has(f.type) || SELECT_SEARCH_TYPES.has(f.type) || f.type === "relation"));
