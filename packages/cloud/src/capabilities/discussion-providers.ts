import { discussionsIssues } from "../contracts/discussions";
import { type CapabilityCaller, listCapabilityCatalog } from "./server-invoke";
import type { CapabilityCatalogApp } from "./types";

// Same interactive discovery budget as the calendar reader. Cursor pages are sequential (one in flight).
const MAX_CALLS = 60;
const MAX_BYTES = 4 * 1024 * 1024;
export type DiscussionProvider = {
  app: CapabilityCatalogApp;
  itemType: string;
  containerType: string;
  containers: string;
  activity?: string;
};

/** Request-local discovery. Failure, truncation, and cancellation throw; no partial success or retained authority. */
export const discussionProviders = async (
  caller: CapabilityCaller,
  options: { deadline: number; signal?: AbortSignal },
): Promise<DiscussionProvider[]> => {
  if (!Number.isFinite(options.deadline)) throw new RangeError("Discussion deadline must be a finite epoch time in milliseconds");
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...[caller.signal, options.signal].filter((signal): signal is AbortSignal => !!signal),
  ]);
  const timer = setTimeout(() => controller.abort(new Error("DISCUSSION_DEADLINE")), Math.max(0, options.deadline - Date.now()));
  let bytes = 0;
  const addBytes = (size: number) => {
    bytes += size;
    if (bytes > MAX_BYTES) {
      controller.abort(new Error("DISCUSSION_BYTE_BUDGET"));
      signal.throwIfAborted();
    }
  };
  const credentials: CapabilityCaller = {
    ...caller,
    signal,
    ...(!caller.authority
      ? {
          transport: async (request: Request) => {
            const response = await (caller.transport ?? ((request: Request) => fetch(request, { redirect: "error" })))(request);
            if (!response.body) return response;
            const body = response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, stream) {
                  addBytes(chunk.byteLength);
                  stream.enqueue(chunk);
                },
              }),
              { signal },
            );
            return new Response(body, { status: response.status, headers: response.headers });
          },
        }
      : {}),
  };
  const providers: DiscussionProvider[] = [];
  const seen = new Set<string>();
  const appIds = new Set<string>();
  let cursor: string | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (let calls = 0; calls < MAX_CALLS; calls++) {
      if (options.deadline <= Date.now()) controller.abort(new Error("DISCUSSION_DEADLINE"));
      signal.throwIfAborted();
      const page = await Promise.race([listCapabilityCatalog({ caller: credentials, cursor, limit: 25 }), cancelled]);
      signal.throwIfAborted();
      if (!page.ok) throw new Error(`Discussion discovery unavailable: ${page.error.code}`);
      if (caller.authority) addBytes(new TextEncoder().encode(JSON.stringify(page.data)).byteLength);
      for (const app of page.data.apps) {
        const role = app.manifest.discussions;
        const model = app.manifest.resourceTypes?.find((model) => model.type === role?.item);
        if (!role || !model?.container || discussionsIssues(app.manifest).length || appIds.has(app.appId)) continue;
        appIds.add(app.appId);
        providers.push({
          app,
          itemType: `${app.appId}.${role.item}`,
          containerType: `${app.appId}.${model.container}`,
          containers: role.containers,
          ...(role.activity ? { activity: role.activity } : {}),
        });
      }
      if (!page.data.page.hasMore) return providers;
      cursor = page.data.page.nextCursor;
      if (seen.has(cursor)) throw new Error("DISCUSSION_CURSOR_LOOP");
      seen.add(cursor);
    }
    throw new Error("DISCUSSION_CALL_BUDGET");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
};
