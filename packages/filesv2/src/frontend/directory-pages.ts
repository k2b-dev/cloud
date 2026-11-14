import type { DirectoryView } from "./workspace-state";

export function directoryPageCount(params: URLSearchParams): number {
  const value = params.get("pages");
  if (value === null) return 1;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid directory page count");
  return Number(value);
}

/** The same cumulative window on the server, navigation, and background refresh. */
export async function directoryPages(
  count: number,
  after: string | undefined,
  load: (after: string | undefined) => Promise<DirectoryView>,
  signal: AbortSignal,
  previous?: DirectoryView,
): Promise<DirectoryView> {
  let result = previous;
  let loaded = previous?.loadedPages ?? 0;
  let next = previous ? (previous.next ?? undefined) : after;
  const seen = new Set<string>();
  while (loaded < count && (!result || next)) {
    signal.throwIfAborted();
    if (next && seen.has(next)) throw new Error("Repeated directory cursor");
    if (next) seen.add(next);
    const page = await load(next);
    signal.throwIfAborted();
    if (result && page.failure) throw new Error(page.failure);
    const items = result ? [...result.items, ...page.items] : page.items;
    result = { ...page, items, loadedPages: ++loaded };
    next = page.next ?? undefined;
  }
  if (!result) throw new Error("Missing directory page");
  return result;
}

/** Selection does not change the loaded window. Filters, location and sort do. */
export function directoryContext(source: string): string {
  const url = new URL(source, "https://files.invalid");
  url.searchParams.delete("pages");
  url.searchParams.delete("file");
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}
