import { FilegateError, type ListingOptions, type Page } from "@k2b/filegate";
import { FilesError } from "./errors";
import type { FilesRoot } from "./filegate-facade";

/** Filegate admits two searches per root and answers a third with 429 and `Retry-After: 1`. */
const BUSY_RETRIES = 2;
const BUSY_DELAY_MS = 1000;
/** Filegate's 10-second scan budget, a short wait for a search slot and the page transfer. */
const SEARCH_CALL_MS = 15_000;
/** The longest one search may hold a request: three tries of one page, a busy wait each, and the trash count. */
export const SEARCH_REQUEST_SECONDS = 60;

/**
 * One Filegate search page. Filegate's own input checks (400) become `invalid_input`. A busy root is retried twice after a second; a spent search budget (413) becomes
 * `search_limited`. A first page whose observation changed while it was served (409) restarts once; a
 * continuation reports `cursor_invalid`, so the caller discards its pages and restarts the query.
 */
export async function searchPage(
  root: FilesRoot,
  q: string,
  options: ListingOptions & { path: string; signal?: AbortSignal },
): Promise<Page> {
  let restarted = false;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(SEARCH_CALL_MS);
    try {
      return await root.search(q, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    } catch (error) {
      if (!(error instanceof FilegateError)) throw error;
      if (error.status === 400) throw new FilesError("invalid_input");
      if (error.status === 413) throw new FilesError("search_limited");
      if (error.status === 429) {
        if (attempt >= BUSY_RETRIES) throw new FilesError("search_busy", 503);
        options.signal?.throwIfAborted();
        await Bun.sleep(BUSY_DELAY_MS);
        continue;
      }
      if (error.status === 409 && error.code === "cursor_invalid") {
        if (options.after || restarted) throw new FilesError("cursor_invalid", 409);
        restarted = true;
        continue;
      }
      throw error;
    }
  }
}

/**
 * Hits inside the base's trash, which Files never shows, or null when unknown. The same query below the trash
 * folder selects the same entries only when every match tier counts (relevance), only one does (exact), or no name
 * is searched; other sorts drop loose hits depending on the rest of the selection. With `in: "path"`, a word that
 * only matches the trash folder's own name still counts above it but not here.
 */
export async function trashHits(
  root: FilesRoot,
  q: string,
  options: ListingOptions & { path: string; signal?: AbortSignal },
): Promise<number | null> {
  if (q && options.sort !== "relevance" && options.match !== "exact") return null;
  try {
    return (await searchPage(root, q, { ...options, after: undefined, limit: 1 })).total ?? null;
  } catch (error) {
    if (error instanceof FilegateError && error.status === 404) return 0;
    if (error instanceof FilesError && ["search_limited", "search_busy", "cursor_invalid"].includes(error.code)) return null;
    throw error;
  }
}

/** Filegate counts code points in the name, or with `in: "path"` in the path below the search folder; Files always uses the latter. */
export function highlight(relative: string, ranges: readonly (readonly [number, number])[] | undefined, within: "name" | "path") {
  if (!ranges?.length) return [];
  const offset = within === "name" ? Array.from(relative).length - Array.from(relative.split("/").at(-1) ?? "").length : 0;
  return ranges.map(([start, end]): [number, number] => [start + offset, end + offset]);
}
