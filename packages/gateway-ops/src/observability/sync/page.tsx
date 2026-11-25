import { listApps } from "@k2b/cloud";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import { legacySyncNatsHref, selectedFacets, syncQuery } from "../_components/sync-nats-query";
import SyncScreen, { type SyncDeadLetterView, type Worded } from "./_components/SyncScreen.island";
import { syncOpsMessages } from "./ops-messages";
import { syncOpsService } from "./runtime";
import {
  isListedResource,
  needsAttention,
  type SyncAppRow,
  type SyncDeadLetterRow,
  type SyncResourceRow,
  syncOpsCredentials,
} from "./service";

const PATH = "/admin/observability/nats/sync";

const resourceStatus = (state: SyncResourceRow["state"]): Worded["status"] =>
  state === "ready" ? "ok" : state === "pending" ? null : state === "drifted" ? "warn" : "bad";

const healthStatus = (app: SyncAppRow): Worded["status"] => {
  if (app.status !== "ok" || !app.health) return "bad";
  if (app.health.state === "ready") return "ok";
  return "warn";
};

const detailNumber = (resource: SyncResourceRow, key: string): number | null => {
  const value = resource.detail?.[key];
  return typeof value === "number" ? value : null;
};

/** Sync on v2. The address holds the filters, the open store with its page, and the open dead letter. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const { t: o } = syncOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const legacy = legacySyncNatsHref(PATH, url.searchParams);
  if (legacy) return c.redirect(legacy);

  const credentials = syncOpsCredentials(c.req.raw);
  // The app named in the address stays a value of its filter, so the address reads the same before the apps are known.
  const address = syncQuery(locale, { apps: [] }, selectedFacets(url.searchParams)).parse(url.searchParams);
  const filters = {
    app: address.state.filters.app,
    resource: address.state.search?.trim() || undefined,
    problems: address.state.filters.state === "problems",
  };
  const storeApp = url.searchParams.get("storeApp");
  const store = url.searchParams.get("store");
  const kind = url.searchParams.get("kind");
  const selector: Pick<SyncDeadLetterRow, "appId" | "store" | "kind"> | null =
    storeApp && store && (kind === "queue" || kind === "job" || kind === "topic") ? { appId: storeApp, store, kind } : null;
  const messageId = url.searchParams.get("message");
  const sequenceValue = Number(url.searchParams.get("sequence"));
  const sequence = Number.isSafeInteger(sequenceValue) && sequenceValue > 0 ? sequenceValue : undefined;
  const [registeredApps, overview, storePage, detail, attention] = await Promise.all([
    listApps(),
    syncOpsService.overview(credentials, filters),
    selector
      ? syncOpsService.listDeadLetters({ ...selector, limit: 20, cursor: url.searchParams.get("cursor") || undefined }, credentials)
      : Promise.resolve(null),
    selector && messageId ? syncOpsService.getDeadLetter({ ...selector, messageId, sequence }, credentials) : Promise.resolve(null),
    readAttention(),
  ]);

  const href = (changes: Record<string, string | number | null | undefined>) => {
    const params = new URLSearchParams(url.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined) params.delete(key);
      else params.set(key, String(value));
    }
    return `${PATH}${params.size ? `?${params}` : ""}`;
  };
  const number = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatNumber(value, { locale }));
  const date = (value: string | null | undefined) => (value ? formatDateTime(value, dateConfig) : "—");
  const closeEntry = href({ message: null, sequence: null });

  const rows: SyncDeadLetterRow[] =
    storePage?.ok && selector
      ? storePage.data.store.entries.map((entry) => ({
          ...entry,
          ...selector,
          appName: selector.appId,
          description: storePage.data.store.description,
        }))
      : selector
        ? []
        : overview.deadLetters;
  const deadLetters: SyncDeadLetterView[] = rows.map((row) => ({
    key: `${row.appId}/${row.kind}/${row.store}/${row.messageId}`,
    kind: row.kind,
    appId: row.appId,
    store: row.store,
    messageId: row.messageId,
    tenantId: row.tenantId,
    consumer: row.consumer,
    replayAvailable: row.replayAvailable,
    appName: row.appName,
    attempts: number(row.attempts),
    failedAt: date(row.failedAt),
    reason: row.error ? `${row.reason} — ${row.error}` : row.reason,
    preview: row.dataPreview,
    storeHref: href({ storeApp: row.appId, store: row.store, kind: row.kind, cursor: null, message: null, sequence: null }),
    href: href({ storeApp: row.appId, store: row.store, kind: row.kind, message: row.messageId, sequence: row.streamSequence ?? null }),
  }));

  const reachable = overview.apps.filter((app) => app.status === "ok");
  const failingSchedules = overview.schedules.filter((schedule) => schedule.failureCount > 0 || schedule.lastError);
  const listedResources = overview.resources.filter((resource) => filters.resource || isListedResource(resource));
  const ignored = address.issues.length > 0 ? address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null;
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);
  const entry = detail && selector && messageId ? detail : null;

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: area.area, href: "/admin/observability" },
        { title: area.nats, href: "/admin/observability/nats" },
        { title: "Sync" },
      ]}
    >
      <ObservabilityNavigation label={area.area} current="nats" groups={groups} />
      <SyncScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        facets={{ apps: registeredApps.map((app) => app.id) }}
        state={address.state}
        ignored={ignored}
        sampledAt={date(overview.sampledAt)}
        refreshHref={href({})}
        facts={{
          reachable: number(reachable.length),
          apps: number(overview.apps.length),
          deadLetters:
            overview.truncatedStores.length > 0 ? `${number(overview.deadLetters.length)}+` : number(overview.deadLetters.length),
          attention: number(overview.resources.filter(needsAttention).length),
          failingSchedules: number(failingSchedules.length),
        }}
        unavailable={overview.apps
          .filter((app) => app.status !== "ok")
          .map((app) => ({ name: app.appName, error: app.error ?? t.unavailable }))}
        apps={overview.apps.map((app) => ({
          id: app.appId,
          name: app.appName,
          state: { label: app.status === "ok" ? (app.health ? o[app.health.state] : t.unknown) : t.unavailable, status: healthStatus(app) },
          error: app.error,
          connection: app.health ? o[app.health.connection] : "—",
          workers: number(app.health?.activeWorkers),
          drifted: number(app.health?.driftedResources),
          dropped: number(app.health?.droppedEvents),
        }))}
        deadLetters={deadLetters}
        store={
          selector
            ? {
                label: `${selector.appId} / ${selector.store}`,
                clearHref: href({ storeApp: null, store: null, kind: null, cursor: null, message: null, sequence: null }),
                firstHref: href({ cursor: null, message: null, sequence: null }),
                nextHref:
                  storePage?.ok && storePage.data.nextCursor
                    ? href({ cursor: storePage.data.nextCursor, message: null, sequence: null })
                    : null,
                error: storePage && !storePage.ok ? storePage.error.message : null,
              }
            : null
        }
        resources={listedResources.map((row) => ({
          key: `${row.appId}/${row.kind}/${row.id}`,
          appName: row.appName,
          kind: row.kind,
          id: row.id,
          natsHref: row.natsNames[0] ? `/admin/observability/nats?stream=${encodeURIComponent(row.natsNames[0])}` : null,
          state: {
            label: row.state === "pending" ? o.provisioning : row.state === "failed" ? o.failed : o[row.state],
            status: resourceStatus(row.state),
          },
          messages: number(detailNumber(row, "messages")),
          deadLetters: number(row.deadLetters),
          deadLettersBad: row.deadLetters !== null && row.deadLetters > 0,
          error: row.error ?? "",
        }))}
        schedules={overview.schedules.map((row) => ({
          key: `${row.appId}/${row.schedulerId}/${row.id}`,
          appId: row.appId,
          appName: row.appName,
          schedulerId: row.schedulerId,
          id: row.id,
          cron: `${row.cron} · ${row.timezone}`,
          nextRun: date(row.nextRunAt),
          handler: { label: row.handlerAvailable ? o.available : o.unavailable, status: row.handlerAvailable ? "ok" : "warn" },
          lastCompleted: date(row.lastCompletedAt),
          runs: number(row.runNumber),
          failures: number(row.failureCount),
          failing: row.failureCount > 0,
          lastError: row.lastError ?? "",
          lastRunId: row.lastRunId ?? null,
        }))}
        entry={
          entry && selector
            ? entry.ok
              ? {
                  error: null,
                  closeHref: closeEntry,
                  view: {
                    title: entry.data.entry.reason,
                    failedAt: date(entry.data.entry.failedAt),
                    facts: [
                      { label: t.syncFailedAt, value: date(entry.data.entry.failedAt) },
                      { label: t.syncAttempts, value: number(entry.data.entry.attempts) },
                      { label: t.syncReason, value: entry.data.entry.reason },
                      { label: o.tenant, value: entry.data.entry.tenantId, mono: true },
                      { label: o.consumer, value: entry.data.entry.consumer ?? "—" },
                      { label: t.syncStore, value: `${selector.appId} / ${selector.store} · ${selector.kind}` },
                      { label: t.syncMessageId, value: entry.data.entry.messageId, mono: true },
                      { label: o.event, value: entry.data.entry.eventId ?? "—", mono: true },
                    ],
                    error: entry.data.entry.error,
                    preview: entry.data.entry.dataPreview,
                    previewBounded: o.previewBounded,
                    target: {
                      ...selector,
                      messageId: entry.data.entry.messageId,
                      tenantId: entry.data.entry.tenantId,
                      consumer: entry.data.entry.consumer,
                      replayAvailable: entry.data.entry.replayAvailable,
                    },
                    closeHref: closeEntry,
                  },
                }
              : { view: null, error: entry.error.message, closeHref: closeEntry }
            : null
        }
      />
    </Layout>
  );
});
