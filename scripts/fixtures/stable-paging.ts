/**
 * Offset-paging fixture for lists sorted by a timestamp.
 *
 * Rows written in one transaction share `now()`, so a list ordered only by
 * that timestamp has no defined order among them: consecutive LIMIT/OFFSET
 * pages can repeat some rows and skip others. Tests insert such a tie, walk
 * every page with a small page size, and compare the fixture ids they saw
 * with the order of the unique tie-break.
 */

/** Walks offset pages until a short page; returns every key in page order. */
export const collectPages = async <Key>(
  fetchPage: (page: { page: number; offset: number; limit: number }) => Promise<Key[]>,
  limit = 3,
): Promise<Key[]> => {
  const keys: Key[] = [];
  for (let page = 1; page <= 1_000; page++) {
    const rows = await fetchPage({ page, offset: (page - 1) * limit, limit });
    keys.push(...rows);
    if (rows.length < limit) return keys;
  }
  throw new Error("collectPages did not reach the last page within 1000 pages");
};

/** Keeps only the fixture keys, preserving the order the pages returned them in. */
export const fixtureKeys = <Key>(keys: Key[], fixture: Iterable<Key>): Key[] => {
  const wanted = new Set(fixture);
  return keys.filter((key) => wanted.has(key));
};

/** Lowercase UUID strings sort like Postgres `uuid` values. */
export const descending = (keys: Iterable<string>): string[] => [...keys].sort().reverse();
