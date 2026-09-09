import { ButtonLink, DataTable, type DataTableColumn, NoticeCard, StatCell, StatGrid, StatusBadge, type StatusTone } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { listApps } from "@k2b/cloud";
import SyncNatsFilterBar from "../_components/SyncNatsFilterBar.island";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import DeadLetterDetail from "./_components/DeadLetterDetail";
import { syncOpsMessages } from "./ops-messages";
import DeadLetterActions from "./_components/DeadLetterActions.island";
import RunScheduleNowButton from "./_components/RunScheduleNowButton.island";
import { syncOpsService } from "./runtime";
import {
  isListedResource,
  needsAttention,
  type SyncAppRow,
  type SyncDeadLetterRow,
  type SyncResourceRow,
  type SyncScheduleRow,
  syncOpsCredentials,
} from "./service";

const resourceTone = (state: SyncResourceRow["state"]): StatusTone => {
  if (state === "ready") return "ok";
  if (state === "pending") return "running";
  if (state === "drifted") return "warning";
  return "error";
};

const healthTone = (app: SyncAppRow): StatusTone => {
  if (app.status !== "ok" || !app.health) return "error";
  if (app.health.state === "ready") return "ok";
  if (app.health.state === "degraded" || app.health.connection !== "connected") return "degraded";
  return "warning";
};

const detailNumber = (resource: SyncResourceRow, key: string): number | null => {
  const value = resource.detail?.[key];
  return typeof value === "number" ? value : null;
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const { t: o } = syncOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const selectedResource = url.searchParams.get("resource") || undefined;
  const selectedApp = url.searchParams.get("app") || undefined;
  const problems = ["true", "on"].includes(url.searchParams.get("problems") ?? "");
  const credentials = syncOpsCredentials(c.req.raw);
  const [overview, registeredApps] = await Promise.all([
    syncOpsService.overview(credentials, { app: selectedApp, resource: selectedResource, problems }),
    listApps(),
  ]);
  const href = (changes: Record<string, string | number | null | undefined>) => {
    const params = new URLSearchParams(url.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined) params.delete(key);
      else params.set(key, String(value));
    }
    return `/admin/observability/sync?${params}`;
  };
  const storeApp = url.searchParams.get("storeApp");
  const store = url.searchParams.get("store");
  const kind = url.searchParams.get("kind");
  const selector: Pick<SyncDeadLetterRow, "appId" | "store" | "kind"> | null =
    storeApp && store && (kind === "queue" || kind === "job" || kind === "topic") ? { appId: storeApp, store, kind } : null;
  const storePage = selector
    ? await syncOpsService.listDeadLetters({ ...selector, limit: 20, cursor: url.searchParams.get("cursor") || undefined }, credentials)
    : null;
  const messageId = url.searchParams.get("message");
  const sequenceValue = Number(url.searchParams.get("sequence"));
  const sequence = Number.isSafeInteger(sequenceValue) && sequenceValue > 0 ? sequenceValue : undefined;
  const detail = selector && messageId ? await syncOpsService.getDeadLetter({ ...selector, messageId, sequence }, credentials) : null;
  const deadLetters =
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
  const storeHref = (row: SyncDeadLetterRow) =>
    href({ storeApp: row.appId, store: row.store, kind: row.kind, cursor: null, message: null, sequence: null });
  const number = (value: number) => formatNumber(value, { locale });

  const reachable = overview.apps.filter((app) => app.status === "ok");
  const unavailable = overview.apps.filter((app) => app.status !== "ok");
  const attention = overview.resources.filter(needsAttention);
  const listedResources = overview.resources.filter((resource) => selectedResource || isListedResource(resource));
  const failingSchedules = overview.schedules.filter((schedule) => schedule.failureCount > 0 || schedule.lastError);

  const appColumns: DataTableColumn<SyncAppRow>[] = [
    { id: "app", header: t.app, value: (row) => row.appName },
    { id: "status", header: t.status, value: (row) => row.status },
    { id: "connection", header: t.syncConnection, value: (row) => row.health?.connection ?? "—" },
    { id: "workers", header: t.syncWorkers, value: (row) => row.health?.activeWorkers ?? null, align: "right" },
    { id: "drifted", header: t.syncDrifted, value: (row) => row.health?.driftedResources ?? null, align: "right" },
    { id: "dropped", header: t.syncDroppedEvents, value: (row) => row.health?.droppedEvents ?? null, align: "right" },
  ];

  const deadLetterColumns: DataTableColumn<SyncDeadLetterRow>[] = [
    { id: "app", header: t.app, value: (row) => row.appName },
    { id: "store", header: t.syncStore, value: (row) => row.store, cellClass: "font-mono text-[11px]" },
    { id: "messageId", header: t.syncMessageId, value: (row) => row.messageId, cellClass: "font-mono text-[11px] max-w-[12rem] truncate" },
    { id: "attempts", header: t.syncAttempts, value: (row) => row.attempts, align: "right" },
    { id: "failedAt", header: t.syncFailedAt, value: (row) => row.failedAt },
    { id: "reason", header: t.syncReason, value: (row) => row.reason, cellClass: "max-w-[16rem]" },
    { id: "payload", header: t.syncPayload, value: (row) => row.dataPreview, cellClass: "font-mono text-[11px] max-w-[20rem] truncate" },
    { id: "actions", header: t.actions, value: () => null, align: "right" },
  ];

  const resourceColumns: DataTableColumn<SyncResourceRow>[] = [
    { id: "app", header: t.app, value: (row) => row.appName },
    { id: "kind", header: t.syncKind, value: (row) => row.kind },
    { id: "id", header: t.syncResourceId, value: (row) => row.id, cellClass: "font-mono text-[11px] max-w-[18rem] truncate" },
    { id: "state", header: t.syncState, value: (row) => row.state },
    { id: "messages", header: t.syncMessages, value: (row) => detailNumber(row, "messages"), align: "right" },
    { id: "deadLetters", header: t.syncDeadLetters, value: (row) => row.deadLetters, align: "right" },
    { id: "error", header: t.error, value: (row) => row.error ?? "", cellClass: "max-w-[16rem] truncate text-red-600 dark:text-red-400" },
  ];

  const scheduleColumns: DataTableColumn<SyncScheduleRow>[] = [
    { id: "app", header: t.app, value: (row) => row.appName },
    { id: "scheduler", header: t.syncScheduler, value: (row) => row.schedulerId, cellClass: "font-mono text-[11px]" },
    { id: "id", header: t.syncSchedule, value: (row) => row.id, cellClass: "font-mono text-[11px] max-w-[16rem] truncate" },
    { id: "cron", header: t.syncCron, value: (row) => `${row.cron} · ${row.timezone}`, cellClass: "font-mono text-[11px]" },
    { id: "nextRunAt", header: t.syncNextRun, value: (row) => row.nextRunAt },
    { id: "handler", header: o.handler, value: (row) => (row.handlerAvailable ? o.available : o.unavailable) },
    { id: "lastCompletedAt", header: o.lastCompleted, value: (row) => row.lastCompletedAt },
    { id: "runNumber", header: t.syncRuns, value: (row) => row.runNumber, align: "right" },
    { id: "failureCount", header: t.syncFailures, value: (row) => row.failureCount, align: "right" },
    { id: "lastError", header: t.syncLastError, value: (row) => row.lastError ?? "", cellClass: "max-w-[16rem] truncate" },
    { id: "actions", header: t.actions, value: () => null, align: "right" },
  ];

  return () => (
    <AdminLayout c={c} title="Sync">
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-sync-title">
          <h1 class="text-base font-semibold text-primary">Sync</h1>
          <p class="mt-1 text-xs text-dimmed">{t.syncDescription}</p>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <p class="text-xs text-dimmed">
            {o.sampledAt}: {formatDateTime(overview.sampledAt, dateConfig)}
          </p>
          <ButtonLink href={href({})} variant="secondary" size="sm">
            {o.refresh}
          </ButtonLink>
        </div>
        <SyncNatsFilterBar path="/admin/observability/sync" search={url.search} apps={registeredApps.map((app) => app.id)} />
        <NoticeCard tone="info" icon="ti ti-layers-intersect" title={t.syncLayersTitle} detail={t.syncLayersNotice} />
        <div>
          <ButtonLink href="/admin/observability/nats" variant="secondary" size="sm">
            NATS
          </ButtonLink>
        </div>

        <StatGrid columns={4}>
          <StatCell
            label={t.syncAppsReachable}
            value={number(reachable.length)}
            sub={t.ofValue({ value: number(overview.apps.length) })}
            valueClass={unavailable.length > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={unavailable.length > 0 ? { tone: "amber", icon: "ti ti-plug-connected-x" } : undefined}
          />
          <StatCell
            label={t.syncDeadLetters}
            value={overview.truncatedStores.length > 0 ? `${number(overview.deadLetters.length)}+` : number(overview.deadLetters.length)}
            sub={
              overview.truncatedStores.length > 0
                ? t.syncDeadLettersTruncated({ count: overview.truncatedStores.length })
                : t.syncTransportLayer
            }
            valueClass={overview.deadLetters.length > 0 ? "text-red-500" : "text-primary"}
            accent={overview.deadLetters.length > 0 ? { tone: "red", icon: "ti ti-mail-x" } : undefined}
          />
          <StatCell
            label={t.syncResourcesAttention}
            value={number(attention.length)}
            sub={t.syncResourcesDeclared({ count: number(overview.resources.length) })}
            valueClass={attention.length > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={attention.length > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : undefined}
          />
          <StatCell
            label={t.syncSchedules}
            value={number(overview.schedules.length)}
            sub={failingSchedules.length > 0 ? t.syncSchedulesFailing({ count: number(failingSchedules.length) }) : t.none}
            valueClass={failingSchedules.length > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
          />
        </StatGrid>

        {unavailable.length ? (
          <section class="grid gap-2 md:grid-cols-2">
            {unavailable.map((app) => (
              <NoticeCard tone="danger" title={t.syncAppUnavailable({ app: app.appName })} detail={app.error ?? t.unavailable} />
            ))}
          </section>
        ) : null}

        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.apps}</h2>
            <p class="text-[10px] text-dimmed">{t.syncAppsHint}</p>
          </div>
          <DataTable
            rows={overview.apps}
            surface="plain"
            columns={appColumns}
            getRowId={(row) => row.appId}
            density="compact"
            hoverRows
            empty={t.syncNoApps}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "status") {
                return (
                  <StatusBadge
                    tone={healthTone(row)}
                    label={row.status === "ok" ? (row.health ? o[row.health.state] : t.unknown) : t.unavailable}
                    variant="dot"
                    title={row.error ?? undefined}
                  />
                );
              }
              if (col.id === "connection" && row.health) return o[row.health.connection];
              if (typeof value === "number") return <span class="tabular-nums">{number(value)}</span>;
              return render(value ?? "—");
            }}
          />
        </section>

        <section id="sync-dead-letters" class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.syncDeadLetters}</h2>
            <p class="text-[10px] text-dimmed">{selector ? o.oldest : t.syncDeadLettersHint}</p>
            <p class="text-xs text-dimmed">{selector ? `${selector.appId} / ${selector.store}` : o.overviewLimit}</p>
            {selector ? (
              <ButtonLink
                href={href({ storeApp: null, store: null, kind: null, cursor: null, message: null, sequence: null })}
                variant="secondary"
                size="xs"
              >
                {o.clear}
              </ButtonLink>
            ) : null}
          </div>
          <DataTable
            rows={deadLetters}
            columns={deadLetterColumns}
            getRowId={(row) => `${row.appId}/${row.kind}/${row.store}/${row.messageId}`}
            density="compact"
            hoverRows
            class="max-h-[34rem] overflow-auto"
            empty={t.syncNoDeadLetters}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "actions")
                return (
                  <div class="flex flex-wrap items-center justify-end gap-2">
                    <ButtonLink
                      href={`${href({
                        storeApp: row.appId,
                        store: row.store,
                        kind: row.kind,
                        message: row.messageId,
                        sequence: row.streamSequence,
                      })}#sync-dead-letter-detail`}
                      size="xs"
                      variant="secondary"
                    >
                      {o.details}
                    </ButtonLink>
                    <DeadLetterActions
                      kind={row.kind}
                      appId={row.appId}
                      store={row.store}
                      messageId={row.messageId}
                      tenantId={row.tenantId}
                      consumer={row.consumer}
                      replayAvailable={row.replayAvailable}
                    />
                  </div>
                );
              if (col.id === "failedAt") return <span class="tabular-nums">{formatDateTime(row.failedAt, dateConfig)}</span>;
              if (col.id === "store")
                return <a class="link" href={`${storeHref(row)}#sync-dead-letters`} title={o.store}>{`${row.store} · ${row.kind}`}</a>;
              if (col.id === "reason")
                return <span title={row.error ?? undefined}>{row.error ? `${row.reason} — ${row.error}` : row.reason}</span>;
              if (col.id === "payload") return <span title={row.dataPreview}>{row.dataPreview}</span>;
              if (typeof value === "number") return <span class="tabular-nums">{number(value)}</span>;
              return render(value);
            }}
          />
        </section>

        {storePage && !storePage.ok ? <NoticeCard tone="danger" title={o.pageError} detail={storePage.error.message} /> : null}
        {storePage?.ok ? (
          <div class="flex gap-2">
            <ButtonLink href={href({ cursor: null, message: null, sequence: null })} variant="secondary" size="sm">
              {o.first}
            </ButtonLink>
            {storePage.data.nextCursor ? (
              <ButtonLink href={href({ cursor: storePage.data.nextCursor, message: null, sequence: null })} variant="secondary" size="sm">
                {o.next}
              </ButtonLink>
            ) : null}
          </div>
        ) : null}
        {detail ? (
          detail.ok ? (
            <DeadLetterDetail entry={detail.data.entry} closeHref={href({ message: null, sequence: null })} />
          ) : (
            <NoticeCard tone="danger" title={o.detailError} detail={detail.error.message} />
          )
        ) : null}

        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.syncResources}</h2>
            <p class="text-[10px] text-dimmed">{t.syncResourcesHint}</p>
            {selectedResource ? (
              <a class="link text-xs" href="/admin/observability/sync">
                {t.clearSearch}: {selectedResource}
              </a>
            ) : null}
          </div>
          <DataTable
            rows={listedResources}
            columns={resourceColumns}
            getRowId={(row) => `${row.appId}/${row.kind}/${row.id}`}
            density="compact"
            hoverRows
            class="max-h-[34rem] overflow-auto"
            empty={t.syncNoResources}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "state")
                return (
                  <StatusBadge
                    tone={resourceTone(row.state)}
                    label={row.state === "pending" ? o.provisioning : row.state === "failed" ? o.failed : o[row.state]}
                    variant="dot"
                  />
                );
              if (col.id === "id" && row.natsNames[0])
                return (
                  <a class="link" href={`/admin/observability/nats?stream=${encodeURIComponent(row.natsNames[0])}`}>
                    {render(value)}
                  </a>
                );
              if (col.id === "deadLetters" && row.deadLetters !== null && row.deadLetters > 0) {
                return <span class="tabular-nums font-semibold text-red-500">{number(row.deadLetters)}</span>;
              }
              if (typeof value === "number") return <span class="tabular-nums">{number(value)}</span>;
              return render(value ?? "—");
            }}
          />
        </section>

        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold text-primary">{t.syncSchedules}</h2>
            <p class="text-[10px] text-dimmed">{t.syncSchedulesHint}</p>
          </div>
          <DataTable
            rows={overview.schedules}
            columns={scheduleColumns}
            getRowId={(row) => `${row.appId}/${row.schedulerId}/${row.id}`}
            density="compact"
            hoverRows
            class="max-h-[34rem] overflow-auto"
            empty={t.syncNoSchedules}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "actions")
                return (
                  <RunScheduleNowButton appId={row.appId} schedulerId={row.schedulerId} scheduleId={row.id} lastRunId={row.lastRunId} />
                );
              if (col.id === "nextRunAt" || col.id === "lastCompletedAt")
                return <span class="tabular-nums">{typeof value === "string" ? formatDateTime(value, dateConfig) : "—"}</span>;
              if (col.id === "handler")
                return (
                  <StatusBadge
                    variant="dot"
                    tone={row.handlerAvailable ? "ok" : "warning"}
                    label={row.handlerAvailable ? o.available : o.unavailable}
                  />
                );
              if (col.id === "failureCount" && row.failureCount > 0) {
                return <span class="tabular-nums font-semibold text-amber-600 dark:text-amber-400">{number(row.failureCount)}</span>;
              }
              if (col.id === "lastError" && row.lastError) return <span title={row.lastError}>{row.lastError}</span>;
              if (typeof value === "number") return <span class="tabular-nums">{number(value)}</span>;
              return render(value);
            }}
          />
        </section>
      </div>
    </AdminLayout>
  );
});
