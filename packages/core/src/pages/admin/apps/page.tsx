import { type AppRegistryDetail, assessRuntimeCompatibility, listAppsDetailed, readAppRegistrySnapshot } from "@k2b/cloud";
import { appAccessMessages } from "@k2b/cloud/access/ui";
import type { AppAccessRule } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import {
  AppAccessManagementError,
  accounts,
  appAdminFacts,
  appDetails,
  appKeys,
  canRepairAppAccess,
  coreSettings,
  latestGatewayRouteSnapshot,
  logger,
  readAppAccess,
  serviceAccountCredentials,
} from "@k2b/cloud/services";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { readAppStatusDetail, readAppStatusSummaries } from "../../../app-status";
import { listAppListing } from "../../../known-apps";
import { ssr } from "../../../config";
import { settingsDocumentationHref } from "../settings/documentation";
import { appsFormat } from "./format";
import type { KeyEntry } from "./keys-dialogs";
import { type AppInput, type AppStatusWindow, deriveApp, parseAppsQuery, type ProviderNumbers, sortApps } from "./model";
import { appsPageMessages } from "./page-messages";
import { AppsView, type AppsViewData, type DetailData, type RouteRow } from "./view";

/** Platform services that route but are not apps an administrator manages here. */
const HIDDEN = new Set(["gateway", "gateway-router"]);
/** The list asks providers for at most this many apps at once (the `app-status.summary` limit). */
const SUMMARY_LIMIT = 200;

const log = logger("admin-apps");

/** A provider's link of one kind; providers name what a link opens, Core never knows their paths. */
const linkOf = (numbers: readonly ProviderNumbers[], kind: "logs" | "metrics" | "routes" | "capabilities") =>
  numbers.flatMap((item) => item.links).find((link) => link.kind === kind)?.href ?? null;

/** How many Queries and Actions the app offers, from its current catalog entry. */
const capabilityCount = async (appId: string, locale: string, authority: Parameters<typeof getCapabilityCatalogApp>[2]) => {
  const app = await getCapabilityCatalogApp(appId, locale, authority).catch(() => null);
  return app ? app.manifest.queries.length + app.manifest.actions.length : null;
};

/** The access rule as one phrase, in the words of the access editor. */
const ruleLabel = (locale: string, access: AppAccessRule | undefined): string => {
  const t = appAccessMessages.resolve([locale]).t;
  switch (access?.kind) {
    case "resources":
      return t.resourcesLabel;
    case "grants":
      return t.configurable;
    case "signedIn":
      return t.fixedSignedInLabel;
    case "noGuests":
      return t.fixedNoGuestsLabel;
    case "roles":
      return access.roles?.length === 1 && access.roles[0] === "admin" ? t.fixedAdminsLabel : t.fixedRolesLabel;
    default:
      return t.legacyLabel;
  }
};

/** Declared prefixes the router sends elsewhere or nowhere; empty without a router state, which the page says. */
const missingRoutes = (
  app: AppRegistryDetail,
  router: Awaited<ReturnType<typeof latestGatewayRouteSnapshot>>,
  names: ReadonlyMap<string, string>,
): AppInput["missingRoutes"] => {
  if (!router) return [];
  const routed = new Map(router.routes.map((route) => [route.prefix, route.appId]));
  return app.routes
    .filter((prefix) => routed.get(prefix) !== app.id)
    .map((prefix) => {
      const owner = routed.get(prefix);
      return { prefix, owner: owner ? (names.get(owner) ?? owner) : null };
    });
};

export default ssr<AuthContext>(async (c) => {
  const authority = auth.getAuthority(c);
  if (!canRepairAppAccess(authority)) return ssr.error(c, 403);
  const locale = getLocale(c);
  const dateContext = getDateConfig(c);
  const format = appsFormat(dateContext);
  const query = parseAppsQuery(c.req.query());
  if (query.invalidApp) return ssr.error(c, 404);
  const signal = c.req.raw.signal;
  const user = c.get("user");
  const localized = new Map(getLocalizedRuntimeContext(c).apps.map((app) => [app.id, app]));

  // Level 1: every app the registry, Core or a provider knows. The registry failing is the list failing; the apps run on.
  let list: AppsViewData["list"] = { state: "failed" };
  let entries: ReturnType<typeof deriveApp>[] = [];
  let live: AppRegistryDetail[] = [];
  let summaries: Awaited<ReturnType<typeof readAppStatusSummaries>> | null = null;
  try {
    const [snapshot, detailed, router] = await Promise.all([
      readAppRegistrySnapshot(),
      listAppsDetailed(),
      latestGatewayRouteSnapshot().catch(() => null),
    ]);
    live = detailed.filter((app) => !HIDDEN.has(app.id));
    const known = (await listAppListing({ liveApps: live })).filter((entry) => !HIDDEN.has(entry.id));
    const ids = known.map((entry) => entry.id).sort();
    summaries = await readAppStatusSummaries({ authority, appIds: ids.slice(0, SUMMARY_LIMIT), window: "24h", locale, signal });
    const listing = summaries.otherApps.length
      ? (await listAppListing({ liveApps: live, otherApps: summaries.otherApps })).filter((entry) => !HIDDEN.has(entry.id))
      : known;
    const facts = await appAdminFacts(
      authority,
      listing.map((entry) => entry.id),
    );
    const compatibility = assessRuntimeCompatibility(live);
    const names = new Map(listing.map((entry) => [entry.id, localized.get(entry.id)?.name ?? entry.name]));
    const failedProviders = new Set(summaries.failures.map((failure) => failure.provider.appId));
    entries = listing.map((entry) => {
      const app = entry.live;
      const fact = facts.get(entry.id);
      const numbers: ProviderNumbers[] = summaries?.byApp.get(entry.id) ?? [];
      const issue = snapshot.issues.find((candidate) => candidate.key === `apps/${entry.id}`);
      return deriveApp({
        id: entry.id,
        name: names.get(entry.id) ?? entry.id,
        description: localized.get(entry.id)?.description ?? entry.description,
        icon: entry.icon,
        accent: entry.accent,
        live: Boolean(app),
        heartbeatStale: Boolean(app && app.expiresAt - Date.now() < 30_000),
        release: app?.runtime?.version ?? app?.runtime?.release ?? entry.release,
        routes: app?.routes ?? entry.routes,
        adminHref: app?.nav?.adminHref ?? entry.adminHref,
        logsHref: linkOf(numbers, "logs"),
        instances: app ? (app.instances?.length ?? null) : null,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: app ? new Date(app.updatedAt).toISOString() : entry.lastSeenAt,
        firstKnownAt: fact?.firstKnownAt ?? entry.firstSeenAt,
        coreKnows: entry.source.some((source) => source !== "provider"),
        accessKind: (app?.access?.kind as AppInput["accessKind"]) ?? null,
        access: fact?.access ?? null,
        keys: fact ? { ...fact.keys } : { active: 0, expired: 0, revoked: 0, lastUsedAt: null, accountStatus: null },
        failedDeliveries: fact?.events.failedDeliveries ?? 0,
        runtimeIssues: [
          ...(issue ? [{ severity: "error" as const, message: issue.reason }] : []),
          ...compatibility
            .filter((item) => item.appIds.includes(entry.id))
            .map((item) => ({ severity: item.severity, message: item.message })),
        ],
        missingRoutes: app ? missingRoutes(app, router, names) : [],
        numbers,
        numbersUnavailable: failedProviders.size > 0 && numbers.length === 0,
      });
    });
    list = {
      state: "ok",
      apps: sortApps(entries, locale),
      issues: snapshot.issues.map((issue) => ({ key: issue.key, reason: issue.reason })),
      unchecked: summaries.truncated.length,
      logsHref: entries.find((entry) => entry.logsHref)?.logsHref ?? null,
    };
  } catch (error) {
    log.error("Could not load the app list", { error });
  }

  // Level 2: the open app. An app no source knows has no page.
  const entry = query.app ? (entries.find((candidate) => candidate.id === query.app) ?? null) : null;
  if (query.app && !entry && list.state === "ok") return ssr.error(c, 404);
  const liveApp = entry ? live.find((app) => app.id === entry.id) : undefined;
  const details =
    entry && entry.coreKnows && !entry.neverStarted
      ? await appDetails(entry.id, { authority, locale }).catch((error: unknown) => {
          log.error("Could not load the app details", { appId: entry.id, error });
          return null;
        })
      : null;
  const reservedKeys = entry ? entry.id === "core" || entry.id === "gateway" : true;
  const keyList =
    entry && !reservedKeys
      ? await appKeys
          .list({ actor: user, appId: entry.id, page: 1, perPage: 100 })
          .then((result) => (result.ok ? (result.data.items as KeyEntry[]) : null))
          .catch(() => null)
      : null;
  const providerFailures = summaries?.failures.map((failure) => failure.provider.name) ?? [];

  // Level 3: the column the URL names.
  const detail: DetailData | null = await (async (): Promise<DetailData | null> => {
    if (!entry || !query.view) return null;
    switch (query.view) {
      case "access": {
        const access = liveApp?.access ?? localized.get(entry.id)?.access;
        const editor =
          liveApp && access?.kind === "grants"
            ? {
                app: { id: entry.id, name: entry.name, access },
                repair: true,
                initial: await readAppAccess({ app: { id: entry.id, name: entry.name, access }, authority, repair: true }).catch(
                  (error: unknown) => {
                    if (!(error instanceof AppAccessManagementError && error.status === 403))
                      log.error("Could not load the access repair list", { appId: entry.id, error });
                    return undefined;
                  },
                ),
              }
            : null;
        return { view: "access", rule: ruleLabel(locale, access), editor };
      }
      case "keys": {
        const tokens = await serviceAccountCredentials
          .listOverview({
            pagination: { page: 1, perPage: 20 },
            filter: { serviceAccountKind: "resource_bound", resourceType: "cloud.app", appId: entry.id, resourceId: entry.id },
          })
          .catch(() => null);
        const creators = [...new Set((keyList ?? []).map((key) => key.createdBy).filter((id): id is string => Boolean(id)))];
        const people = Object.fromEntries(
          (await Promise.all(creators.map((id) => accounts.users.get({ id }).catch(() => null))))
            .filter((person) => person !== null)
            .map((person) => [person.id, person.displayName || person.uid]),
        );
        return {
          view: "keys",
          keys: {
            app: { id: entry.id, name: entry.name },
            neverStarted: entry.neverStarted,
            initialKeys: keyList,
            people,
            accountStatus: entry.keys.accountStatus,
            tokens: tokens
              ? {
                  items: tokens.items.map((item) => ({
                    id: item.id,
                    name: item.name,
                    tokenPrefix: item.tokenPrefix,
                    status: item.status,
                    expiresAt: item.expiresAt,
                    lastUsedAt: item.lastUsedAt,
                  })),
                  total: tokens.total,
                  hasNext: tokens.hasNext,
                }
              : null,
            docsHref: settingsDocumentationHref(await coreSettings.get<string>("app.documentation_url"), "app-keys") ?? null,
            timeZone: dateContext.timeZone ?? "UTC",
          },
        };
      }
      case "events":
        return details ? { view: "events" } : null;
      case "routes":
      case "errors": {
        const window: AppStatusWindow = query.view === "routes" ? query.window : "24h";
        const [statusDetail, router] = await Promise.all([
          readAppStatusDetail({ authority, appId: entry.id, window, locale, signal }),
          latestGatewayRouteSnapshot().catch(() => null),
        ]);
        const providers = statusDetail.results.map((result) => result.provider.name);
        const failures = statusDetail.failures.map((failure) => failure.provider.name);
        const telemetryHref = linkOf(entry.numbers, "metrics");
        if (query.view === "errors") {
          const result = statusDetail.results[0];
          return {
            view: "errors",
            failedRequests: result?.failedRequests ?? [],
            total: result?.totalFailedRequests ?? null,
            providers,
            failures,
            telemetryHref,
            logsHref: entry.logsHref,
          };
        }
        const routed = new Map((router?.routes ?? []).map((route) => [route.prefix, route.appId]));
        const numbers = new Map(statusDetail.results.flatMap((result) => result.routes).map((route) => [route.prefix, route]));
        const names = new Map(entries.map((candidate) => [candidate.id, candidate.name]));
        const rows: RouteRow[] = entry.routes.map((prefix) => {
          const owner = routed.get(prefix);
          const measured = numbers.get(prefix);
          return {
            prefix,
            requests: measured ? measured.requests : null,
            errors: measured ? measured.errors : null,
            router: !router ? "unknown" : owner === entry.id ? "active" : "missing",
            owner: owner && owner !== entry.id ? (names.get(owner) ?? owner) : null,
          };
        });
        const traffic = entry.numbers.find((item) => item.traffic)?.traffic;
        return {
          view: "routes",
          window,
          rows,
          providers,
          failures,
          routerKnown: Boolean(router),
          avgMs: window === "24h" ? (traffic?.avgMs ?? null) : null,
          telemetryHref,
          routesHref: linkOf(entry.numbers, "routes"),
        };
      }
      case "runtime": {
        const app = liveApp;
        const keyNames = new Map((keyList ?? []).map((key) => [key.keyId, key.name]));
        return {
          view: "runtime",
          release: app?.runtime?.version ?? app?.runtime?.release ?? entry.release,
          build: app?.runtime?.release ?? null,
          sync: app?.runtime?.syncVersion ?? null,
          baseUrl: app?.baseUrl ?? null,
          heartbeatAt: app ? new Date(app.updatedAt).toISOString() : entry.lastSeenAt,
          startedAt: app?.startedAt ? new Date(app.startedAt).toISOString() : app ? new Date(app.createdAt).toISOString() : null,
          issues: entry.runtimeIssues,
          instances: (app?.instances ?? []).map((instance) => ({
            hostname: instance.hostname,
            startedAt: new Date(instance.startedAt).toISOString(),
            via: instance.bootstrap ? (instance.bootstrap.mode === "core" ? "key" : "env") : "unknown",
            keyName: instance.bootstrap?.keyId ? (keyNames.get(instance.bootstrap.keyId) ?? null) : null,
          })),
          inRail: Boolean(app?.nav?.href),
          adminHref: entry.adminHref,
          capabilities: app?.capabilities ? await capabilityCount(entry.id, locale, authority) : null,
          capabilitiesHref: linkOf(entry.numbers, "capabilities"),
        };
      }
    }
  })();

  const data: AppsViewData = {
    locale,
    format,
    query,
    list,
    app: entry
      ? {
          entry,
          details,
          revokedKeyName: keyList?.find((key) => key.status === "revoked")?.name ?? null,
          providerFailures,
          appNames: new Map(entries.map((candidate) => [candidate.id, candidate.name])),
        }
      : null,
    detail,
  };
  return () => (
    <AdminLayout c={c} title={entry?.name ?? appsPageMessages.resolve([locale]).t.apps} ownMain>
      <AppsView data={data} />
    </AdminLayout>
  );
});
