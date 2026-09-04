/**
 * defineApp() — The single entry point for every cloud app.
 *
 * Merges SSR config, app meta, and server bootstrap into one call.
 * Returns `{ ssr, plugin, config, meta, start }`.
 */

import type { SsrConfig } from "@k2b/ssr";
import { createConfig as createSsrConfig } from "@k2b/ssr";
import { routes } from "@k2b/ssr/hono";
import { type Context, type Handler, Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { env } from "../config/env";
import type {
  AppAdminNavigationGroup,
  AppAppearance,
  AppLifecycle,
  AppMeta,
  AppPresentationCatalog,
  CloudContext,
  WidgetEndpoint,
} from "../contracts/app";
import { CAPABILITY_FRAMEWORK_ERROR_CODES, CAPABILITY_MAX_REQUEST_BYTES, type CapabilityDefinitions } from "../contracts/capabilities";
import { type BoundNotificationMap, bindNotificationDefinitions, type NotificationDefinitionMap } from "../contracts/notification-types";
import type { AppRegistryEntry } from "../contracts/registry";
import type { AppSettingsMap, KindToType } from "../contracts/settings-types";
import type { Role } from "../contracts/shared";
import type { HelpDefinition } from "../server/help";
import { getLocale, resolveLocale } from "../server/locale";
import { type AuthContext, auth } from "../server/middleware/auth";
import { requireInvocation } from "../server/middleware/invocation";
import { routeTemplate } from "../server/middleware/route-template";
import { runtime as runtimeMiddleware } from "../server/middleware/runtime";
import { settings as settingsMiddleware } from "../server/middleware/settings";
import {
  capabilityInvocationOperation,
  searchInvocationOperation,
  widgetInvocationOperation,
} from "../services/identity/invocation-operations";
import { logger } from "../services/logging";
import { startNotificationDefinitionRegistration } from "../services/notifications/catalog";
import { get, loadCache as loadSettingsCache, set } from "../services/settings";
import { createSettingsAPI, type SettingsAPI } from "../services/settings/api";
import { registerSettings, toLegacySettingDefs } from "../services/settings/defaults";
import { capabilityMessages } from "../shared/capability-messages";
import { normalizeLocale } from "../shared/locale";
import { themeBootstrapScript } from "../shared/theme";
import { appFaviconHref } from "./app-favicon";
import { compileAppPresentation } from "./app-presentation";
import { readBoundedJson } from "./bounded-json";
import { appRuntimeMetadata } from "./build-metadata";
import { compileCapabilities, invokeCompiledCapability, reviewCompiledCapability, serializeCapabilityProviderResult } from "./capabilities";
import { createHeartbeat } from "./heartbeat";
import { compileHelp } from "./help";
import { APP_READINESS_PATH, appReadinessResponse } from "./readiness";
import { type CapabilityRegistryRecord, capabilityRegistry, helpRegistry } from "./registry";
import { ensureRuntimeWatcher, getCurrentRuntime, stopRuntimeWatcher } from "./runtime-watcher";
import { servePublicAsset } from "./static-assets";
import { createStatusPreservingSsrHandler } from "./status-preserving-ssr";

/** Cache-busting version stamp — changes on every server start / rebuild. */
const v = Date.now();

type PageOptions = {
  title?: string;
  description?: string;
  theme?: "light" | "dark";
  /** Framework-resolved BCP 47 document language — always the canonical request locale, never a page override. */
  lang?: string;
};

// ── Public types ────────────────────────────────────────────────────────────

/**
 * App definition options.
 *
 * `S` is the inferred per-app settings map (see `AppSettingsMap`). Apps that
 * declare `settings: { ... } as const` get S inferred to the literal shape;
 * `AppContext<typeof app>` then exposes the typed snapshot on `c.get("settings")`.
 *
 * Apps that omit `settings` get S = {} (no own settings — only core's are
 * available in their snapshot, populated by core's own defineApp.settings).
 */
export type AppOptions<S extends AppSettingsMap = {}, N extends NotificationDefinitionMap = {}, AppId extends string = string> = {
  id: AppId;
  name: string;
  icon: string;
  description: string;
  /** Optional localized overlays for app-owned presentation metadata. */
  presentation?: AppPresentationCatalog;
  appearance?: AppAppearance;
  /** URL prefix for SSR asset isolation. Omit for the global `/_ssr/` path (core). */
  basePath?: string;
  /** Base URL as seen by other containers (e.g. "http://app-notebooks:3000"). */
  baseUrl: string;
  adminHref?: string;
  /** Multi-link admin navigation contributed by this app. */
  adminNav?: ReadonlyArray<{
    id?: string;
    label: string;
    links: ReadonlyArray<{ label: string; href: string; icon: string }>;
  }>;
  nav?: {
    href: string;
    match?: string;
    section: "primary" | "more" | "hidden";
    requiresAuth?: boolean;
    requiresRoles?: Role[];
  };
  /**
   * Settings owned by this app, declared as a map of dotted-key → definition.
   *
   * Example: `{ "files.filegate_url": { kind: "url", default: "" } }`.
   *
   * These keys are exposed as a typed nested snapshot on `c.get("settings")`
   * for any Hono route using `Hono<AppContext<typeof app>>`. Writes go through
   * `app.settings.set(key, value)` (also typed). The runtime registry
   * (`SETTINGS_MAP` in `services/settings/defaults.ts`) is populated from
   * this map automatically on `defineApp()` call.
   */
  settings?: S;
  /** Notification kinds owned by this app, conventionally imported from `src/notifications.ts`. */
  notifications?: N;
  /**
   * Legal/info links contributed by this app — aggregated app-wide via
   * `listLegalLinks()` and rendered in login footer, app Footer, rail more
   * dropdown. Each app contributes its own (e.g. core owns
   * Imprint/Privacy/Terms; faq owns FAQ). KISS: no `external` flag, links
   * always open in a new tab from the login footer.
   */
  legalLinks?: ReadonlyArray<{ label: string; href: string; icon?: string }>;
  /**
   * Dashboard widget endpoints this app exposes. Each entry references an
   * HTTP path on this app that returns a `WidgetResponse`. The dashboard
   * reaches the declared handler through Core; the endpoint remains
   * responsible for permission gating (200 = render, 403 = unavailable at
   * the user's access level, 204 = no content).
   */
  widgets?: ReadonlyArray<WidgetEndpoint>;
  /**
   * Top-level URL prefixes the gateway should route to this app.
   *
   * Standard apps follow a four-prefix convention:
   *   `/api/<id>`     — widget, admin, ws, crud — everything HTTP API
   *   `/app/<id>`     — user-facing SSR pages
   *   `/admin/<id>`   — admin SSR pages
   *   `/public/<id>`  — built CSS and other static assets
   *
   * Apps with non-standard URLs (core's `/auth`, `/me`, `/legal/*`, `/impressum`;
   * oauth's `/oauth`, `/.well-known/...`) list whatever
   * top-level paths they own. The gateway is dumb — it just builds a
   * prefix-trie from these strings.
   */
  routes: readonly string[];
  /**
   * Gateway-relative URL at which this app's OpenAPI 3.x JSON spec is
   * served, e.g. `"/api/notebooks/openapi.json"`. Opt-in: only set this
   * for apps whose api router is documented with `middleware.openapi()`
   * (i.e. `describeRoute()`) and worth surfacing in the api-docs aggregator.
   *
   * Pair this with `app.start({ openapi: <api router> })` — `defineApp`
   * generates the spec from that router at boot, mounts it on the
   * framework server (before the user's fetch, so it bypasses any
   * auth/rate-limit middleware), and advertises the URL via the registry
   * so `app-api-docs` picks it up automatically.
   *
   * The path must be reachable through the gateway — usually that means
   * the standard form `"/api/<id>/openapi.json"` (covered by the
   * `/api/<id>` entry in `routes`).
   */
  openapi?: string;
  /**
   * Project root used by the SSR plugin to discover island/client files.
   * Defaults to `process.cwd()`. Override only if you run the entrypoint
   * from a directory other than the project root.
   */
  appRoot?: string;
};

export type StartOptions = {
  /**
   * Web-standard fetch handler. Mounted at `/` of the app's container.
   * Typically you pass a Hono instance's `.fetch`:
   *
   *   const router = new Hono<AuthContext>()
   *     .use("*", middleware.runtime())
   *     .use("*", middleware.settings())
   *     .route("/api/<id>", apiRoutes)
   *     .route("/app/<id>", pageRoutes);
   *
   *   app.start({ fetch: router.fetch });
   *
   * The framework owns `/_ssr/*`, `/public/*`, and the versioned internal
   * capability and widget endpoints when their handlers are declared, and
   * registers them before this fetch — they take precedence over any
   * catch-all the app might register.
   */
  fetch: (req: Request, env?: unknown) => Response | Promise<Response>;
  /**
   * Hono router to scan for OpenAPI route metadata. When set together with
   * `defineApp({ openapi: "..." })`, the framework generates an OpenAPI
   * spec from this router and mounts it at the configured URL on the
   * framework server (before the user's fetch, so the spec stays public).
   *
   * Pass the BARE api router — the one with `describeRoute()` annotations.
   * `generateSpecs` walks the route tree without executing middleware, so
   * the inner auth/rate-limit `.use(...)` calls don't matter for spec
   * generation; they only run if the router is hit by an actual request.
   */
  openapi?: Hono<any>;
  lifecycle?: AppLifecycle;
  capabilities?: CapabilityDefinitions;
  /**
   * Handlers for declared dashboard widgets, keyed by widget id. The
   * framework exposes these only on its invocation-authenticated internal
   * route; applications may keep mounting the same handlers on their public
   * compatibility paths during the rolling migration.
   */
  widgets?: Readonly<Record<string, Handler<AuthContext>>>;
  help?: HelpDefinition;
  port?: number;
  skipSetup?: boolean;
};

export type StartResult = {
  hostname: "0.0.0.0";
  port: number;
  development: boolean;
  fetch: Hono["fetch"];
};

export type AppDefinition<S extends AppSettingsMap = {}, N extends NotificationDefinitionMap = {}, AppId extends string = string> = {
  // Bind the generic explicitly — without it, ssr collapses to the constraint
  // `object` and apps lose the typed `c.get("page")` (title/description/theme).
  ssr: ReturnType<typeof createStatusPreservingSsrHandler<PageOptions>>;
  plugin: () => import("bun").BunPlugin;
  config: SsrConfig;
  meta: AppMeta;
  baseUrl: string;
  start: (opts: StartOptions) => Promise<StartResult>;
  /**
   * Phantom field — type-only carrier for the per-app settings shape. Always
   * `undefined` at runtime; do not read or assign. Used by `AppContext<App>`
   * to extract the inferred settings map via `App["_settings"]`.
   */
  readonly _settings: S;
  /**
   * Typed async settings API for this app. Keys constrained to those declared
   * in `defineApp({ settings: ... })`. Backed by Redis cache-aside (see store.ts).
   *
   * Use for read/write outside of request-scoped sync access. Inside HTTP
   * handlers, prefer `c.get("settings").x.y` (the per-request snapshot, sync,
   * frozen for the duration of the request).
   */
  readonly settings: SettingsAPI<{ [K in keyof S]: KindToType<S[K]["kind"]> }>;
  /** Typed notification descriptors declared by this app. */
  readonly notifications: BoundNotificationMap<AppId, N>;
};

// ── Implementation ──────────────────────────────────────────────────────────

export const defineApp = <
  const S extends AppSettingsMap = {},
  const N extends NotificationDefinitionMap = {},
  const AppId extends string = string,
>(
  opts: AppOptions<S, N, AppId>,
): AppDefinition<S, N, AppId> => {
  const isDevelopment = process.env.NODE_ENV === "development";
  const notifications = bindNotificationDefinitions(opts.id, opts.notifications);

  // ── 0. Register declared settings into the runtime registry ──────────
  // SETTINGS_MAP is the single source of truth for validation in store.ts
  // (writeKey checks SETTINGS_MAP.get(key)) and for snapshot.ts (allKnownKeys
  // returns SETTINGS.map(d => d.key)). Without this registration, app-declared
  // settings would be type-known but runtime-unknown.
  if (opts.settings) {
    registerSettings(toLegacySettingDefs(opts.settings as Record<string, unknown>, opts.presentation?.baseLocale ?? "en"));
  }

  // ── 1. SSR config ─────────────────────────────────────────────────────
  const { config, plugin, html } = createSsrConfig<PageOptions>({
    dev: isDevelopment,
    verbose: true,
    rootDir: opts.appRoot ?? process.cwd(),
    basePath: opts.basePath,
    template: ({ body, scripts, title, description, theme, lang }) => {
      const themeFixed = theme !== undefined;
      return `<!DOCTYPE html>
<html lang="${normalizeLocale(lang)}" class="${theme ?? "light"}"${themeFixed ? " data-theme-fixed" : ""}>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="view-transition" content="same-origin">
    <title>${title ?? "Cloud"}</title>
    <meta name="description" content="${description ?? "Cloud workspace"}">
    <meta name="theme-color" content="#09090b">
    <meta name="mobile-web-app-capable" content="yes">
    <link rel="icon" href="${appFaviconHref(opts.id, v)}">
    <style data-cloud-css-layers>@layer theme, base, components, utilities;</style>
    <link rel="preload" href="/public/tabler-icons.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/public/fonts.css?v=${v}">
    <link rel="stylesheet" href="/public/tabler-icons.css?v=${v}">
    <link rel="stylesheet" href="/public/${opts.id}/app.css?v=${v}">
    <link rel="stylesheet" href="/public/global.css?v=${v}">
    <script>${themeBootstrapScript}</script>
  </head>
  <body class="k2b-ui" data-k2b-app-workspace-controller="global">
    ${body}
  </body>
  ${scripts}
</html>`;
    },
  });

  // Pass PageOptions explicitly so c.get("page") in apps' SSR handlers is
  // typed as Partial<PageOptions> (with title/description/theme), not the
  // bare `object` fallback the constraint would otherwise produce.
  //
  // The finalize hook resolves the request locale for `<html lang>` after all
  // route middlewares ran (so the settings snapshot is present), keeping the
  // document language request-scoped without per-page plumbing. It assigns
  // unconditionally: `<html lang>`, the Layout LocaleProvider, and
  // `getDateConfig` share one canonical `getLocale(c)` that page handlers
  // cannot override.
  const ssr = createStatusPreservingSsrHandler<PageOptions>(html, (c) => {
    c.get("page").lang = getLocale(c);
  });

  // ── 2. Meta ───────────────────────────────────────────────────────────
  const baseMeta: AppMeta = {
    id: opts.id,
    name: opts.name,
    icon: opts.icon,
    description: opts.description,
    appearance: opts.appearance,
    adminHref: opts.adminHref,
    adminNav: opts.adminNav?.map(
      (group): AppAdminNavigationGroup => ({
        id: group.id,
        label: group.label,
        links: group.links.map((link) => ({ ...link })),
      }),
    ),
    routes: [...opts.routes],
    nav: opts.nav,
    legalLinks: opts.legalLinks ? [...opts.legalLinks] : undefined,
    widgets: opts.widgets ? opts.widgets.map((w) => ({ ...w })) : undefined,
    settingKeys: opts.settings ? Object.keys(opts.settings) : undefined,
    openapi: opts.openapi,
  };
  const meta: AppMeta = { ...baseMeta, presentation: compileAppPresentation(baseMeta, opts.presentation) };

  // ── 3. start() — builds and boots the Hono server ────────────────────
  const start = async (startOpts: StartOptions): Promise<StartResult> => {
    const port = startOpts.port ?? 3000;
    const baseUrl = opts.baseUrl;
    const log = logger("app");

    // Settings are encrypted at rest, so every container needs the secret. It
    // is only read on the first decrypt, which meant a container without it
    // booted cleanly and failed much later with an unrelated-looking error.
    if (!env.APP_SECRET.trim()) {
      throw new Error(
        `APP_SECRET is not set (app "${meta.id}"). Settings are encrypted at rest and every app in the ` +
          "deployment must share the same value; without it the first settings read fails.",
      );
    }

    // OpenAPI advertised in the registry only when there's a router to
    // derive the spec from. The mount block lower down uses the same
    // flag so the registry never points at a URL that 404s.
    const advertiseOpenapi = !!(opts.openapi && startOpts.openapi);
    const compiledCapabilities = startOpts.capabilities ? compileCapabilities(meta.id, startOpts.capabilities) : undefined;
    const compiledHelp = startOpts.help
      ? compileHelp({
          appId: meta.id,
          appName: meta.name,
          appIcon: meta.icon,
          basePath: opts.basePath,
          definition: startOpts.help,
        })
      : undefined;

    // Registry entry
    const entry: AppRegistryEntry = {
      id: meta.id,
      name: meta.name,
      icon: meta.icon,
      description: meta.description,
      presentation: meta.presentation,
      appearance: meta.appearance,
      baseUrl,
      runtime: appRuntimeMetadata,
      routes: [...meta.routes],
      nav:
        meta.nav || meta.adminHref
          ? {
              href: meta.nav?.href ?? "",
              match: meta.nav?.match,
              section: meta.nav?.section ?? "hidden",
              requiresAuth: meta.nav?.requiresAuth,
              requiresRoles: meta.nav?.requiresRoles,
              adminHref: meta.adminHref,
            }
          : undefined,
      adminNav: meta.adminNav?.map((group) => ({
        id: group.id,
        label: group.label,
        links: group.links.map((link) => ({ ...link })),
      })),
      capabilities: compiledCapabilities
        ? {
            protocolVersion: compiledCapabilities.manifest.protocolVersion,
            manifestHash: compiledCapabilities.manifest.manifestHash,
          }
        : undefined,
      help: compiledHelp?.summary,
      legalLinks: meta.legalLinks ? meta.legalLinks.map((l) => ({ ...l })) : undefined,
      widgets: meta.widgets ? meta.widgets.map((w) => ({ ...w })) : undefined,
      settingKeys: meta.settingKeys ? [...meta.settingKeys] : undefined,
      openapi: advertiseOpenapi ? opts.openapi : undefined,
    };

    // Heartbeat
    const heartbeat = createHeartbeat(meta.id, entry, {
      onError: (error) =>
        log.error("Registry heartbeat failed", {
          appId: meta.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      onStale: (error) => {
        log.error("Registry heartbeat could not renew the app lease; restarting", {
          appId: meta.id,
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      },
    });
    const capabilityEntry: CapabilityRegistryRecord | undefined = compiledCapabilities
      ? {
          appId: meta.id,
          manifest: compiledCapabilities.manifest,
          presentation: compiledCapabilities.presentation,
        }
      : undefined;
    const capabilityHeartbeat = capabilityEntry
      ? createHeartbeat(meta.id, capabilityEntry, {
          key: `capabilities/${meta.id}`,
          registry: capabilityRegistry,
          onError: (error) =>
            log.error("Capability registry heartbeat failed", {
              appId: meta.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          onStale: (error) => {
            log.error("Capability registry lease expired; restarting", {
              appId: meta.id,
              error: error instanceof Error ? error.message : String(error),
            });
            process.exit(1);
          },
        })
      : undefined;
    const helpHeartbeat = compiledHelp
      ? createHeartbeat(meta.id, compiledHelp.registryEntry, {
          key: `help/${meta.id}`,
          registry: helpRegistry,
          onError: (error) =>
            log.error("Help registry heartbeat failed", {
              appId: meta.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          onStale: (error) => {
            log.error("Help registry lease expired; restarting", {
              appId: meta.id,
              error: error instanceof Error ? error.message : String(error),
            });
            process.exit(1);
          },
        })
      : undefined;
    try {
      // Publish the corpus before the app advertises its manifest.
      await helpHeartbeat?.start();
      await heartbeat.start();
      await capabilityHeartbeat?.start();
    } catch (error) {
      await capabilityHeartbeat?.stop();
      await heartbeat.stop();
      await helpHeartbeat?.stop();
      throw error;
    }
    log.info(`Registered "${meta.id}"`, { baseUrl });

    // Runtime context — start the registry watcher so middleware.runtime() and
    // the lifecycle context below see populated cluster state. Idempotent: the
    // watcher is a module-level singleton, only one runs per process.
    await ensureRuntimeWatcher();

    // Build Hono server. Framework owns these mounts (registered first so
    // they take precedence over any catch-all in the user's fetch):
    //   /_ssr/*                 island chunks (SSR adapter)
    //   /public/*               serveStatic + terminal 404
    //   /api/_internal/capabilities/v1/* when capabilities are declared
    //   /api/_internal/widgets/v1/*     when widget handlers are bound
    //   <opts.openapi>          OpenAPI JSON spec, when both opts.openapi
    //                            and startOpts.openapi are set
    const ssrMountPath = config.basePath ? `${config.basePath}/_ssr` : "/_ssr";

    // Framework-owned mounts answer before the app's router ever runs, so the
    // app middleware cannot report their template. Without this, every hashed
    // island chunk would land in telemetry as its own route.
    const server = new Hono<AuthContext>()
      .use("*", routeTemplate)
      .get(APP_READINESS_PATH, () => appReadinessResponse(meta.id))
      .route(ssrMountPath, routes(config))
      .all("/public/*", servePublicAsset(isDevelopment));

    if (compiledHelp) {
      const pageBase = compiledHelp.summary.pageBase;
      const centralPageBase = `/help/apps/${encodeURIComponent(meta.id)}`;
      server.get(pageBase, (c) => c.redirect(centralPageBase, 302));
      server.get(`${pageBase}/:topic`, (c) => c.redirect(`${centralPageBase}/${encodeURIComponent(c.req.param("topic"))}`, 302));
    }

    if (compiledCapabilities) {
      const invoke = async (c: Context<AuthContext>, kind: "query" | "action" | "review") => {
        // Framework-owned endpoints run before the app's settings middleware,
        // so the operator default is read directly instead of via a snapshot.
        const requestLocale = resolveLocale(c.req.raw.headers, await get<string>("app.locale"));
        const messages = capabilityMessages(requestLocale);
        const parsedBody = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
        if (!parsedBody.ok) {
          const message = parsedBody.reason === "too_large" ? messages.requestTooLarge : messages.requestBodyJson;
          return c.json({ code: CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed, message }, 400);
        }
        if (
          typeof parsedBody.data !== "object" ||
          parsedBody.data === null ||
          Array.isArray(parsedBody.data) ||
          !Object.hasOwn(parsedBody.data, "input") ||
          Object.keys(parsedBody.data).length !== 1
        ) {
          return c.json(
            {
              code: CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed,
              message: messages.requestInputOnly,
            },
            400,
          );
        }
        const body = parsedBody.data as { input: unknown };
        const actor = c.get("actor");
        const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
        const idempotencyKey = c.req.header("idempotency-key") || undefined;
        const invocation = {
          compiled: compiledCapabilities,
          localId: c.req.param("capabilityId") ?? "",
          input: body.input,
          expectedSchemaHash: c.req.header("x-cloud-capability-schema-hash") ?? null,
          context: {
            actor,
            accessSubject: c.get("accessSubject"),
            user,
            idempotencyKey,
            locale: requestLocale,
            signal: c.req.raw.signal,
          },
          onUnexpectedError: (error: unknown) =>
            log.error(kind === "review" ? "Capability review failed" : "Capability execution failed", {
              appId: meta.id,
              kind,
              capabilityId: c.req.param("capabilityId") ?? "",
              error: error instanceof Error ? error.message : String(error),
            }),
        };
        const result =
          kind === "review" ? await reviewCompiledCapability(invocation) : await invokeCompiledCapability({ ...invocation, kind });
        const operation = kind === "action" ? compiledCapabilities.actions.get(invocation.localId) : undefined;
        const serialized = serializeCapabilityProviderResult(result, {
          nonIdempotentAction: kind === "action" && operation?.manifest.idempotency === "none",
        });
        return new Response(serialized.body, {
          status: serialized.status,
          headers: { "content-type": "application/json" },
        });
      };
      const capabilityAuth = (kind: "queries" | "actions", review = false) =>
        requireInvocation((c) => {
          const localId = c.req.param("capabilityId") ?? "";
          const operation = kind === "queries" ? compiledCapabilities.queries.get(localId) : compiledCapabilities.actions.get(localId);
          if (!operation) return null;
          const requestedOperation = c.req.header("x-cloud-invocation-operation");
          const invocationOperation =
            kind === "queries" &&
            requestedOperation === searchInvocationOperation &&
            "universalSearch" in operation.manifest &&
            operation.manifest.universalSearch
              ? searchInvocationOperation
              : capabilityInvocationOperation(kind, localId, review);
          return {
            targetAppId: meta.id,
            operation: invocationOperation,
            schemaHash: operation.manifest.schemaHash,
          };
        });
      const capabilityReadScope = auth.requireOAuthScope("read", "admin");
      const capabilityWriteScope = auth.requireOAuthScope("write", "admin");
      server.post("/api/_internal/capabilities/v1/queries/:capabilityId", capabilityAuth("queries"), capabilityReadScope, (c) =>
        invoke(c, "query"),
      );
      server.post("/api/_internal/capabilities/v1/actions/:capabilityId", capabilityAuth("actions"), capabilityWriteScope, (c) =>
        invoke(c, "action"),
      );
      server.post(
        "/api/_internal/capabilities/v1/actions/:capabilityId/review",
        capabilityAuth("actions", true),
        capabilityReadScope,
        (c) => invoke(c, "review"),
      );
    }

    if (startOpts.widgets) {
      const declaredWidgetIds = new Set(meta.widgets?.map((widget) => widget.id) ?? []);
      for (const widgetId of Object.keys(startOpts.widgets)) {
        if (!declaredWidgetIds.has(widgetId)) throw new Error(`Widget handler "${widgetId}" is not declared by app "${meta.id}"`);
      }
      server.get(
        "/api/_internal/widgets/v1/:widgetId",
        requireInvocation((c) => {
          const widgetId = c.req.param("widgetId") ?? "";
          if (!declaredWidgetIds.has(widgetId) || !startOpts.widgets?.[widgetId]) return null;
          return { targetAppId: meta.id, operation: widgetInvocationOperation(widgetId), schemaHash: null };
        }),
        runtimeMiddleware(),
        settingsMiddleware(),
        async (c) => {
          const handler = startOpts.widgets?.[c.req.param("widgetId") ?? ""];
          return handler ? handler(c, async () => {}) : c.json({ message: "Widget not found" }, 404);
        },
      );
    }

    // OpenAPI spec mount. Registered on the framework server (before the
    // user-fetch catch-all below) so it bypasses any auth / rate-limit
    // middleware on the api router — the spec must stay reachable without
    // a session for `app-api-docs` to render it.
    //
    // The `servers` override is load-bearing: hono-openapi walks the
    // BARE api router and emits paths relative to its own root (e.g.
    // `/{id}`, `/{id}/notes`), without the `/api/<id>` prefix it ends
    // up under in the user's outer router. We derive that prefix from
    // `opts.openapi` (everything before the trailing `/openapi.json`)
    // so combined Scalar URLs resolve to the real public paths.
    if (advertiseOpenapi) {
      const apiPrefix = opts.openapi!.replace(/\/openapi\.json$/, "") || "/";
      const spec = await generateSpecs(startOpts.openapi!, {
        documentation: {
          info: {
            title: meta.name,
            version: "0.0.1",
            description: meta.description,
          },
          servers: [{ url: apiPrefix }],
        },
      });
      server.get(opts.openapi!, (c) => c.json(spec));
    }

    // User's fetch handles everything else. The framework doesn't inject any
    // context vars here — the user's router is expected to register the
    // middlewares it needs (middleware.runtime, middleware.settings, …).
    //
    // env is threaded through so Bun-specific helpers inside the user's
    // router still work — most importantly `upgradeWebSocket` from hono/bun,
    // which reads the Bun server off `c.env`.
    server.all("*", (c) => Promise.resolve(startOpts.fetch(c.req.raw, c.env)));

    // Lifecycle
    const cloudCtx: CloudContext = {
      logger,
      settings: { get, set },
      runtime: getCurrentRuntime(),
    };

    if (!startOpts.skipSetup && startOpts.lifecycle?.setup) {
      log.info(`Setup: ${meta.id}`);
      await startOpts.lifecycle.setup(cloudCtx);
    }

    const stopNotificationRegistration = await startNotificationDefinitionRegistration(meta.id, notifications);

    await loadSettingsCache();

    if (startOpts.lifecycle?.start) {
      log.info(`Start: ${meta.id}`);
      await startOpts.lifecycle.start(cloudCtx);
    }

    // Graceful shutdown
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      log.info(`Stopping: ${meta.id}`);
      try {
        if (startOpts.lifecycle?.stop) await startOpts.lifecycle.stop(cloudCtx);
      } catch {}
      stopNotificationRegistration();
      await stopRuntimeWatcher();
      await capabilityHeartbeat?.stop();
      await heartbeat.stop();
      await helpHeartbeat?.stop();
    };

    process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
    process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));

    return { hostname: "0.0.0.0", port, development: isDevelopment, fetch: server.fetch };
  };

  return {
    ssr,
    plugin,
    config,
    meta,
    baseUrl: opts.baseUrl,
    start,
    // Phantom — see AppDefinition._settings doc. Do not read at runtime.
    _settings: undefined as unknown as S,
    settings: createSettingsAPI<S>(),
    notifications,
  };
};
