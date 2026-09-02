import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { readBoundedJson } from "../_internal/bounded-json";
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
import { invocationIssuanceMode } from "../services/identity/invocation-runtime";
import { signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { LOCALE_HEADER } from "../shared/locale";
import { capabilityCredentialHeaders } from "./capabilities";
import { type SearchItem, SearchItemSchema, SearchQuerySchema, SearchResponseSchema } from "./search/schemas";

const log = logger("search");

/**
 * Maximum items returned to the client after merging across providers.
 * The frontend has no further limit — this caps the rendered list.
 */
const GLOBAL_RESULT_LIMIT = 30;
const PROVIDER_CONCURRENCY = 8;
const PROVIDER_TIMEOUT_MS = 8_000;
const SIGNING_TIMEOUT_MS = 500;

type HttpSearchProvider = {
  appId: string;
  appName: string;
  appIcon: string;
  endpoint: string;
  tags: string[];
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

const settleBounded = async <T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>) =>
  Promise.all(startBounded(items, concurrency, run));

const waitWithin = <T>(value: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
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
  });

/**
 * Creates the global search route.
 * Discovers search providers from the capability registry and fetches results via HTTP,
 * forwarding the session cookie for authentication.
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
        200: jsonResponse(SearchResponseSchema, "Merged search results"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
        503: jsonResponse(ErrorResponseSchema, "Capability registry unavailable"),
      },
    }),
    v("query", SearchQuerySchema),
    async (c) => {
      expectUserBackedActor(c);

      const query = c.req.valid("query");
      const useInvocation = invocationIssuanceMode() === "jwt";
      const invocationAuthority = useInvocation ? invocationAuthorityFromRequest(auth.getAuthority(c)) : null;
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
      const apps = [
        ...new Map(
          providers.map((provider) => [provider.appId, { id: provider.appId, name: provider.appName, icon: provider.appIcon }]),
        ).values(),
      ].sort((a, b) => a.name.localeCompare(b.name));
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
      const appProviders = query.app ? providers.filter((provider) => provider.appId === query.app) : providers;
      const active =
        query.tag.length === 0 ? appProviders : appProviders.filter((provider) => provider.tags.some((tag) => query.tag.includes(tag)));

      if (query.q.length === 0 && query.tag.length === 0 && !query.app) {
        return c.json({ query: "", count: 0, items: [], apps });
      }

      if (query.tag.length > 0 && active.length === 0) {
        return c.json({
          query: query.q,
          count: 0,
          items: [],
          apps,
          unsupportedTags,
        });
      }

      // Single-provider queries get a larger sample for better local
      // ranking — the global slice below still caps the response. Capped
      // at GLOBAL_RESULT_LIMIT so a single app can saturate the response
      // but no more.
      const effectiveProviderLimit = active.length === 1 ? Math.min(GLOBAL_RESULT_LIMIT, query.provider_limit * 3) : query.provider_limit;
      // The same request-wide budget covers signing and provider I/O.
      const providerDeadline = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      const fanoutSignal = AbortSignal.any([c.req.raw.signal, providerDeadline]);
      const signingSignal = useInvocation ? AbortSignal.any([fanoutSignal, AbortSignal.timeout(SIGNING_TIMEOUT_MS)]) : fanoutSignal;
      // Guard the whole issuance batch once, then reuse the prepared signer for
      // every target. This is one Postgres check per outer search request, not
      // one check per provider.
      const signedInvocations =
        useInvocation && invocationAuthority
          ? await waitWithin(
              (dependencies.withActiveSigner ?? withActiveIdentitySigner)("invocation", (signer) =>
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
                        requestId: c.req.header("x-request-id")?.slice(0, 200),
                        signer,
                      }),
                    signingSignal,
                  ),
                ),
              ),
              signingSignal,
            ).catch((reason) => active.map((): PromiseRejectedResult => ({ status: "rejected", reason })))
          : null;
      // One request-wide budget keeps latency flat as the number of apps grows.
      // Workers that have not started when the deadline expires fail fast on
      // the already-aborted signal instead of opening a fresh timeout window.
      const settled = await settleBounded(active, PROVIDER_CONCURRENCY, async (provider, index) => {
        // Scope tags to those this provider declared. Apps no longer need
        // their own gate — the framework guarantees they only see tags
        // they understand.
        const scopedTags = query.tag.filter((t) => provider.tags.includes(t));

        const headers = useInvocation
          ? await (async () => {
              const signed = await signedInvocations?.[index];
              if (!signed || signed.status === "rejected") {
                throw signed?.reason ?? new Error("Resolved request authority is required for search invocation issuance");
              }
              return new Headers({
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${signed.value.token}`,
              });
            })()
          : capabilityCredentialHeaders(c.req.raw);
        for (const name of ["x-request-id", "traceparent", "tracestate"] as const) {
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
        const envelope = capabilityResultSchema(UniversalSearchDataSchema).safeParse(parsedBody.data);
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

      const items = settled.flatMap((result, index) => {
        if (result.status === "fulfilled") return result.value;

        log.warn("Search provider failed", {
          appId: active[index]?.appId ?? "unknown",
          tags: query.tag,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return [];
      });

      items.sort((a, b) => {
        const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
        if (priorityDiff !== 0) return priorityDiff;
        return a.title.localeCompare(b.title);
      });

      // Multiple focused Queries from one app must not buy that app a larger
      // share of the merged result set.
      const appCounts = new Map<string, number>();
      const appBounded = items.filter((item) => {
        const count = appCounts.get(item.appId) ?? 0;
        if (count >= effectiveProviderLimit) return false;
        appCounts.set(item.appId, count + 1);
        return true;
      });
      const sliced = appBounded.slice(0, GLOBAL_RESULT_LIMIT);

      return c.json({
        query: query.q,
        count: sliced.length,
        items: sliced,
        apps,
        ...(unsupportedTags.length > 0 ? { unsupportedTags } : {}),
      });
    },
  );
};

export type SearchApiType = ReturnType<typeof createSearchRoutes>;
