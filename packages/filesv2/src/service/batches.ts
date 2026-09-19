import { FilegateError } from "@k2b/filegate";
import { FilesError } from "./errors";
import { userPath } from "./paths";

export type ItemResult<T> = { path: string; ok: true; entry: T } | { path: string; ok: false; error: string };
export const operationError = (error: unknown): string =>
  error instanceof FilesError ? error.code : error instanceof FilegateError ? error.code : "operation_unresolved";

/** A selected directory already includes all selected descendants. */
export function normalizeSelection(paths: readonly string[]): string[] {
  if (paths.length < 1 || paths.length > 100) throw new FilesError("invalid_selection");
  const unique = [
    ...new Set(
      paths.map((path) => {
        const value = userPath(path);
        if (!value) throw new FilesError("invalid_path");
        return value;
      }),
    ),
  ];
  return unique.filter((path) => !unique.some((parent) => parent !== path && path.startsWith(`${parent}/`)));
}

/** Validate the entire selection first; report every effect independently. */
export async function runFileBatch<P, T>(
  paths: readonly string[],
  prepare: (path: string) => Promise<P>,
  run: (prepared: P, path: string) => Promise<T>,
) {
  const prepared: ({ path: string; ready: true; value: P } | { path: string; ready: false; error: string })[] = [];
  for (const path of normalizeSelection(paths)) {
    try {
      prepared.push({ path, ready: true, value: await prepare(path) });
    } catch (error) {
      prepared.push({ path, ready: false, error: operationError(error) });
    }
  }
  const entries: T[] = [];
  const results: ItemResult<T>[] = [];
  for (const item of prepared) {
    if (!item.ready) {
      results.push({ path: item.path, ok: false, error: item.error });
      continue;
    }
    try {
      const entry = await run(item.value, item.path);
      entries.push(entry);
      results.push({ path: item.path, ok: true, entry });
    } catch (error) {
      results.push({ path: item.path, ok: false, error: operationError(error) });
    }
  }
  return { entries, results };
}
