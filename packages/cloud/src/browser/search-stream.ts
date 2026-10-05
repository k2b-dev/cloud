import type { SearchApp, SearchItem, SearchProviderStatus, SearchResponse, SearchStreamLine } from "../api/search/schemas";
import { LOCALE_HEADER } from "../shared/locale";

/** Kept local so the browser bundle does not load the server-side search schemas. */
const STREAM_CONTENT_TYPE = "application/x-ndjson";

export type SearchAppStatus = SearchProviderStatus | "searching";

/** Rows one provider line added. A retried app adds a block of its own at the end. */
export type SearchBlock = { appId: string; items: SearchItem[] };

/**
 * One streamed search as the browser shows it. Blocks only ever grow at the end, so nothing already visible moves;
 * `status` says for every app named in `start` whether it is still searching and how it finished.
 */
export type SearchRun = {
  apps: SearchApp[];
  providers: string[];
  status: Record<string, SearchAppStatus>;
  blocks: SearchBlock[];
  unsupportedTags: string[];
  /** The server closed the stream; a retried app may still search afterwards. */
  done: boolean;
  /** The request failed as a whole. */
  failed: boolean;
};

export const emptySearchRun = (): SearchRun => ({
  apps: [],
  providers: [],
  status: {},
  blocks: [],
  unsupportedTags: [],
  done: false,
  failed: false,
});

const itemKey = (item: SearchItem) => `${item.ref.type}\u0000${item.ref.id}`;

export const applySearchLine = (run: SearchRun, line: SearchStreamLine): SearchRun => {
  if (line.type === "start")
    return {
      ...run,
      apps: line.apps,
      providers: line.providers,
      status: Object.fromEntries(line.providers.map((appId) => [appId, "searching" as const])),
      unsupportedTags: line.unsupportedTags ?? [],
    };
  if (line.type === "done") return { ...run, done: true };
  // Only an app that is searching takes a line, which bounds the lines a run accepts.
  if (run.status[line.provider] !== "searching") return run;
  const shown = new Set(run.blocks.flatMap((block) => block.items.map(itemKey)));
  const items = line.results.filter((item) => !shown.has(itemKey(item)));
  return {
    ...run,
    status: { ...run.status, [line.provider]: line.status },
    blocks: items.length ? [...run.blocks, { appId: line.provider, items }] : run.blocks,
  };
};

/** Marks an app as searching again before its retry starts. */
export const retrySearchApp = (run: SearchRun, appId: string): SearchRun => ({
  ...run,
  status: { ...run.status, [appId]: "searching" },
});

export const searchingApps = (run: SearchRun) => run.providers.filter((appId) => run.status[appId] === "searching");
export const failedSearchApps = (run: SearchRun) =>
  run.providers.flatMap((appId) => {
    const status = run.status[appId];
    return status === "timeout" || status === "error" ? [{ appId, status }] : [];
  });
/** Every app has answered: only now may an empty run say that nothing was found. */
export const searchFinished = (run: SearchRun) => (run.done || run.failed) && searchingApps(run).length === 0;

/** An older Core answers with merged JSON; it becomes the same lines, without per-app timing. */
const linesFromResponse = (body: SearchResponse): SearchStreamLine[] => {
  const failed = body.failedApps ?? [];
  const found = [...new Set(body.items.map((item) => item.appId))];
  return [
    {
      type: "start",
      query: body.query,
      apps: body.apps,
      providers: [...new Set([...found, ...failed])],
      ...(body.unsupportedTags ? { unsupportedTags: body.unsupportedTags } : {}),
    },
    ...found.map((appId): SearchStreamLine => {
      const results = body.items.filter((item) => item.appId === appId);
      return { type: "provider", provider: appId, status: failed.includes(appId) ? "error" : "ok", results, ms: 0 };
    }),
    ...failed
      .filter((appId) => !found.includes(appId))
      .map((appId): SearchStreamLine => ({ type: "provider", provider: appId, status: "error", results: [], ms: 0 })),
    { type: "done", status: failed.length ? "partial" : "complete", count: body.items.length },
  ];
};

/**
 * Runs one search against `/api/search` and hands over each line as it arrives. Aborting `signal` ends the request,
 * and with it every provider the server still waits for. Rejects when the request fails or the stream breaks off.
 */
export const streamCloudResourceSearch = async (
  url: string,
  options: { signal: AbortSignal; locale: string; onLine: (line: SearchStreamLine) => void },
): Promise<void> => {
  const response = await fetch(url, {
    signal: options.signal,
    headers: { accept: STREAM_CONTENT_TYPE, [LOCALE_HEADER]: options.locale },
  });
  if (!response.ok) throw new Error(`Search failed with ${response.status}`);
  if (!response.headers.get("content-type")?.startsWith(STREAM_CONTENT_TYPE)) {
    const body: SearchResponse = await response.json();
    for (const line of linesFromResponse(body)) options.onLine(line);
    return;
  }
  if (!response.body) throw new Error("Search returned no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let closed = false;
  while (!closed) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += chunk.value;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const text = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (text) {
        const line: SearchStreamLine = JSON.parse(text);
        options.onLine(line);
        if (line.type === "done") closed = true;
      }
      end = buffer.indexOf("\n");
    }
  }
  if (!closed) throw new Error("Search stream ended early");
};
