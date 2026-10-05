import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { readBoundedJson } from "../_internal/bounded-json";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { listCapabilities } from "../_internal/registry";
import type { CapabilityRegistryEntry } from "../contracts";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_RESULT_BYTES,
  capabilityResultSchema,
  ErrorResponseSchema,
  UniversalSearchDataSchema,
} from "../contracts";
import { type AuthContext, auth, expectUserBackedActor, jsonResponse, preferredLocale, requiresAuth, v } from "../server";
import { logger } from "../services";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { searchInvocationOperation } from "../services/identity/invocation-operations";
import { normalizeInvocationRequestId, signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { LOCALE_HEADER } from "../shared/locale";
import {
  SEARCH_STREAM_CONTENT_TYPE,
  type SearchItem,
  SearchItemSchema,
  type SearchProviderStatus,
  SearchQuerySchema,
  type SearchResponse,
  SearchResponseSchema,
  type SearchStreamLine,
  SearchStreamLineSchema,
} from "./search/schemas";

const log = logger("search");
const SearchProviderResultSchema = capabilityResultSchema(UniversalSearchDataSchema);

/**
 * Maximum items of the merged JSON response. A streamed search has no merged
 * list: each app's line carries at most that app's provider limit.
 */
const GLOBAL_RESULT_LIMIT = 30;
const PROVIDER_CONCURRENCY = 8;
const PROVIDER_TIMEOUT_MS = 8_000;

type HttpSearchProvider = {
  appId: string;
  appName: string;
  appIcon: string;
  endpoint: string;
  tags: string[];
  scopeTypes: string[];
  typeIds: Set<string>;
  schemaHash: string;
};

/**
 * Discovers search providers from live capability manifests.
 * Only live apps with a Query that opts into Universal Search are included.
 */
const getSearchProviders = (entries: CapabilityRegistryEntry[]): HttpSearchProvider[] => {
  return entries.flatMap((entry) => {
    return entry.manifest.queries.flatMap((query) =>
      query.universalSearch
        ? [
            {
              appId: entry.appId,
              appName: entry.appName,
              appIcon: entry.appIcon,
              endpoint: `${entry.endpoint}/queries/${encodeURIComponent(query.localId)}`,
              tags: query.universalSearch.tags.flatMap((tag) => [tag.tag, ...(tag.aliases ?? [])]),
              scopeTypes: (query.universalSearch.scopeTypes ?? []).map((type) => `${entry.appId}.${type}`),
              typeIds: new Set(entry.manifest.types.map((type) => `${entry.appId}.${type.localId}`)),
              schemaHash: query.schemaHash,
            },
          ]
        : [],
    );
  });
};

type SearchRouteDependencies = {
  listCapabilities?: () => Promise<CapabilityRegistryEntry[]>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  authenticate?: MiddlewareHandler<AuthContext>;
  signInvocation?: typeof signInvocationToken;
  withActiveSigner?: typeof withActiveIdentitySigner;
};

const startBounded = <T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
) => {
  const deferred = items.map(() => {
    let settled = false;
    let resolve!: (result: PromiseSettledResult<R>) => void;
    const promise = new Promise<PromiseSettledResult<R>>((done) => {
      resolve = (result) => {
        if (settled) return;
        settled = true;
        done(result);
      };
    });
    return { promise, resolve };
  });
  const abort = () => {
    const reason = signal?.reason ?? new Error("Search fan-out deadline exceeded");
    for (const entry of deferred) entry.resolve({ status: "rejected", reason });
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let next = 0;
  void Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        if (signal?.aborted) return;
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        try {
          deferred[index]?.resolve({
            status: "fulfilled",
            value: await run(item, index),
          });
        } catch (reason) {
          deferred[index]?.resolve({ status: "rejected", reason });
        }
      }
    }),
  ).then(() => signal?.removeEventListener("abort", abort));
  return deferred.map((entry) => entry.promise);
};

/** Highest app-provided priority first, then by title. */
const rankItems = (items: SearchItem[]) => items.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.title.localeCompare(b.title));

/** The browser asks for a stream explicitly; every other client keeps the merged JSON response. */
const acceptsStream = (accept: string | undefined) =>
  accept?.split(",").some((type) => type.split(";")[0]?.trim().toLowerCase() === SEARCH_STREAM_CONTENT_TYPE) ?? false;

const streamHeaders = {
  "content-type": `${SEARCH_STREAM_CONTENT_TYPE}; charset=utf-8`,
  // Each line must reach the browser when it is written: no cache, no transformation, no proxy buffering.
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
} as const;

const encoder = new TextEncoder();
const lineText = (line: SearchStreamLine) => `${JSON.stringify(line)}\n`;
const encodeLine = (line: SearchStreamLine) => encoder.encode(lineText(line));

type AppOutcome = { appId: string; status: SearchProviderStatus; items: SearchItem[]; ms: number };

const waitWithin = <T>(value: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    // The work has already started; observe its rejection even if the client
    // disconnected before we began waiting.
    value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
  });

/**
 * Creates the global search route.
 * Discovers search providers from the capability registry and fetches results via HTTP,
 * authenticating each provider with an operation-bound invocation JWT.
 */
export const createSearchRoutes = (dependencies: SearchRouteDependencies = {}) => {
  const registry = dependencies.listCapabilities ?? listCapabilities;
  const fetchProvider = dependencies.fetch ?? globalThis.fetch;
  return new Hono<AuthContext>().use(dependencies.authenticate ?? auth.requireRole("authenticated")).get(
    "/search",
    describeRoute({
      tags: ["Search"],
      summary: "Global search",
      description: "Searches across app providers discovered via the service registry with optional tag filters.",
      ...requiresAuth,
      responses: {
        200: {
          description:
            "Merged search results. With `Accept: application/x-ndjson`, one JSON line per app in the order the apps finish instead.",
          content: {
            "application/json": { schema: resolver(SearchResponseSchema) },
            [SEARCH_STREAM_CONTENT_TYPE]: { schema: resolver(SearchStreamLineSchema) },
          },
        },
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
        503: jsonResponse(ErrorResponseSchema, "Capability registry or invocation authority unavailable"),
      },
    }),
    v("query", SearchQuerySchema),
    async (c) => {
      expectUserBackedActor(c);

      const query = c.req.valid("query");
      const stream = acceptsStream(c.req.header("accept"));
      const requestId = normalizeInvocationRequestId(c.req.header("x-request-id"));
      const invocationAuthority = invocationAuthorityFromRequest(auth.getAuthority(c));
      let entries: CapabilityRegistryEntry[];
      try {
        entries = await registry();
      } catch (error) {
        log.warn("Search capability registry unavailable", { error: error instanceof Error ? error.message : String(error) });
        return c.json(
          {
            code: CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable,
            message: "Capability registry is currently unavailable",
          },
          503,
        );
      }
      const providers = getSearchProviders(entries);
      const requestLocale = preferredLocale(c.req.raw.headers) ?? "en";
      const apps = entries
        .flatMap((entry) => {
          const manifest = resolveCapabilityManifestPresentation(entry.manifest, entry.presentation, requestLocale);
          const queries = manifest.queries.filter((operation) => operation.universalSearch);
          if (!queries.length) return [];
          return [
            {
              id: entry.appId,
              name: entry.appName,
              icon: entry.appIcon,
              tags: [
                ...new Map(
                  queries.flatMap((operation) => (operation.universalSearch?.tags ?? []).map((tag) => [tag.tag, tag] as const)),
                ).values(),
              ],
            },
          ];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const readableTypes = new Set(
        entries.flatMap((entry) => entry.manifest.types.filter((type) => type.reader).map((type) => `${entry.appId}.${type.localId}`)),
      );

      // Pre-filter providers by tag overlap. With no tags, every provider
      // runs (text-only search). With tags, only providers that own at least
      // one requested tag participate — saves fanout to apps that can't
      // contribute. Tags the user typed that no provider declares are
      // returned to the client so it can render a helpful empty state.
      const knownTags = new Set(providers.flatMap((p) => p.tags));
      const unsupportedTags = query.tag.filter((t) => !knownTags.has(t));
      const scope = query.scope_type && query.scope_id ? { type: query.scope_type, id: query.scope_id } : undefined;
      const appProviders = providers.filter(
        (provider) =>
          (!query.app || provider.appId === query.app) &&
          (!scope || provider.scopeTypes.includes(scope.type)) &&
          (!query.scope_tag || provider.tags.includes(query.scope_tag)),
      );
      if ((scope || query.scope_tag) && !appProviders.length)
        return c.json({ code: "INVALID_SEARCH_SCOPE", message: "Search scope is unavailable" }, 400);
      const active =
        query.tag.length === 0 ? appProviders : appProviders.filter((provider) => provider.tags.some((tag) => query.tag.includes(tag)));

      // Answers without a provider call: the catalog alone, or only unsupported tags.
      const answerWithoutProviders = (body: SearchResponse) =>
        stream
          ? new Response(
              [
                lineText({ type: "start", query: body.query, apps, providers: [], ...(body.unsupportedTags ? { unsupportedTags } : {}) }),
                lineText({ type: "done", status: "complete", count: 0 }),
              ].join(""),
              { headers: streamHeaders },
            )
          : c.json(body);

      if (query.q.length === 0 && query.tag.length === 0 && !query.app && !scope) {
        return answerWithoutProviders({ query: "", count: 0, items: [], apps });
      }

      if (query.tag.length > 0 && active.length === 0) {
        return answerWithoutProviders({ query: query.q, count: 0, items: [], apps, unsupportedTags });
      }

      // Single-provider queries get a larger sample for better local
      // ranking — the global slice below still caps the response. Capped
      // at GLOBAL_RESULT_LIMIT so a single app can saturate the response
      // but no more.
      const effectiveProviderLimit = active.length === 1 ? Math.min(GLOBAL_RESULT_LIMIT, query.provider_limit * 3) : query.provider_limit;
      // The same request-wide budget covers signing and provider I/O.
      const providerDeadline = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      // A client that stops reading a stream, such as the browser on the next keystroke, ends the search too.
      const streamCancelled = new AbortController();
      const fanoutSignal = AbortSignal.any([c.req.raw.signal, providerDeadline, streamCancelled.signal]);
      // Guard the whole issuance batch once, then reuse the prepared signer for
      // every target. This is one Postgres check per outer search request, not
      // one check per provider.
      let signedInvocations: PromiseSettledResult<Awaited<ReturnType<typeof signInvocationToken>>>[] | null = null;
      try {
        if (active.length > 0) {
          signedInvocations = await waitWithin(
            (dependencies.withActiveSigner ?? withActiveIdentitySigner)(
              "invocation",
              (signer) =>
                Promise.all(
                  startBounded(
                    active,
                    PROVIDER_CONCURRENCY,
                    (provider) =>
                      (dependencies.signInvocation ?? signInvocationToken)({
                        targetAppId: provider.appId,
                        callingAppId: "core",
                        operation: searchInvocationOperation,
                        schemaHash: provider.schemaHash,
                        authority: invocationAuthority,
                        requestId,
                        signer,
                        issuer: signer.issuer,
                      }),
                    fanoutSignal,
                  ),
                ),
              { signal: fanoutSignal, timeoutMs: PROVIDER_TIMEOUT_MS },
            ),
            fanoutSignal,
          );
        }
      } catch {
        log.warn("Search invocation authority unavailable", {
          reason: fanoutSignal.aborted ? "signing_deadline" : "signing_guard_failed",
        });
        return c.json(
          { code: CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable, message: "Search invocation authority is currently unavailable" },
          503,
        );
      }
      // One request-wide budget keeps latency flat as the number of apps grows.
      // Workers that have not started when the deadline expires fail fast on
      // the already-aborted signal instead of opening a fresh timeout window.
      const fanoutStarted = performance.now();
      const settled = startBounded(active, PROVIDER_CONCURRENCY, async (provider, index) => {
        // Scope tags to those this provider declared. Apps no longer need
        // their own gate — the framework guarantees they only see tags
        // they understand.
        const scopedTags = [...new Set([...(query.scope_tag ? [query.scope_tag] : []), ...query.tag])].filter((tag) =>
          provider.tags.includes(tag),
        );

        const headers = await (async () => {
          const signed = await signedInvocations?.[index];
          if (!signed || signed.status === "rejected") {
            throw signed?.reason ?? new Error("Resolved request authority is required for search invocation issuance");
          }
          return new Headers({
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${signed.value.token}`,
          });
        })();
        if (requestId) headers.set("x-request-id", requestId);
        for (const name of ["traceparent", "tracestate"] as const) {
          const value = c.req.header(name);
          if (value) headers.set(name, value);
        }
        const requestLocale = preferredLocale(c.req.raw.headers);
        if (requestLocale) headers.set(LOCALE_HEADER, requestLocale);
        headers.set("x-cloud-capability-schema-hash", provider.schemaHash);
        headers.set("x-cloud-invocation-operation", searchInvocationOperation);

        const res = await fetchProvider(provider.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: {
              query: query.q,
              tags: scopedTags,
              ...(scope ? { scope } : {}),
              limit: effectiveProviderLimit,
            },
          }),
          signal: fanoutSignal,
        });

        if (!res.ok) {
          throw new Error(`Search provider ${provider.appId} returned ${res.status}`);
        }

        const parsedBody = await readBoundedJson(res, CAPABILITY_MAX_RESULT_BYTES);
        if (!parsedBody.ok) throw new Error(`Search provider ${provider.appId} returned invalid or oversized JSON`);
        const envelope = SearchProviderResultSchema.safeParse(parsedBody.data);
        if (!envelope.success) throw new Error(`Search provider ${provider.appId} returned an invalid capability result`);
        const results = envelope.data.data;
        const validItems: SearchItem[] = [];

        for (const view of results) {
          if (view.ref.type.startsWith(`${provider.appId}.`) && !provider.typeIds.has(view.ref.type)) {
            log.warn("Search capability returned an undeclared provider-owned resource type", {
              appId: provider.appId,
              type: view.ref.type,
            });
            continue;
          }
          const open = view.links.find((link) => link.rel === "open");
          if (!open) {
            log.warn("Search capability returned a resource without an open link", { appId: provider.appId, type: view.ref.type });
            continue;
          }
          const preview = view.links.find((link) => link.rel === "preview");
          const parsed = SearchItemSchema.safeParse({
            ref: view.ref,
            title: view.title,
            href: open.href,
            preview: view.preview,
            icon: view.icon,
            priority: view.priority,
            metadata: view.metadata,
            previewUrl: preview?.href,
            appId: provider.appId,
            appName: provider.appName,
            appIcon: provider.appIcon,
            readable: readableTypes.has(view.ref.type),
          });
          if (!parsed.success) {
            log.warn("Search provider returned invalid item", {
              appId: provider.appId,
              tags: query.tag,
              issues: parsed.error.issues.map((issue) => issue.message),
            });
            continue;
          }
          if (!query.require_reader || parsed.data.readable) validItems.push(parsed.data);
          if (validItems.length >= effectiveProviderLimit) break;
        }

        return validItems;
      });

      // One outcome per app, when all of its Queries have finished. Multiple
      // focused Queries from one app must not buy that app a larger share.
      const appIds = [...new Set(active.map((provider) => provider.appId))];
      const outcomes = appIds.map(async (appId): Promise<AppOutcome> => {
        const results = await Promise.all(active.flatMap((provider, index) => (provider.appId === appId ? [settled[index]!] : [])));
        const failed = results.filter((result) => result.status === "rejected");
        for (const result of failed) {
          log.warn("Search provider failed", {
            appId,
            tags: query.tag,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
        const items = rankItems(results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))).slice(
          0,
          effectiveProviderLimit,
        );
        const status = failed.length ? (providerDeadline.aborted ? "timeout" : "error") : items.length ? "ok" : "empty";
        return { appId, status, items, ms: Math.round(performance.now() - fanoutStarted) };
      });
      const failure = (outcome: AppOutcome) => outcome.status === "timeout" || outcome.status === "error";

      if (stream) {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const write = (line: SearchStreamLine) => {
              if (!cancelled) controller.enqueue(encodeLine(line));
            };
            write({ type: "start", query: query.q, apps, providers: appIds, ...(unsupportedTags.length > 0 ? { unsupportedTags } : {}) });
            let count = 0;
            let partial = false;
            // A slow app never holds back the others: each line is written when its app finishes.
            void Promise.all(
              outcomes.map((pending) =>
                pending.then((outcome) => {
                  count += outcome.items.length;
                  partial ||= failure(outcome);
                  write({ type: "provider", provider: outcome.appId, status: outcome.status, results: outcome.items, ms: outcome.ms });
                }),
              ),
            ).then(() => {
              write({ type: "done", status: partial ? "partial" : "complete", count });
              if (!cancelled) controller.close();
            });
          },
          cancel() {
            cancelled = true;
            streamCancelled.abort();
          },
        });
        return new Response(body, { headers: streamHeaders });
      }

      const finished = await Promise.all(outcomes);
      const items = rankItems(finished.flatMap((outcome) => outcome.items)).slice(0, GLOBAL_RESULT_LIMIT);
      const failedApps = finished.filter(failure).map((outcome) => outcome.appId);

      return c.json({
        query: query.q,
        count: items.length,
        items,
        apps,
        ...(unsupportedTags.length > 0 ? { unsupportedTags } : {}),
        ...(failedApps.length > 0 ? { failedApps } : {}),
      });
    },
  );
};

export type SearchApiType = ReturnType<typeof createSearchRoutes>;
