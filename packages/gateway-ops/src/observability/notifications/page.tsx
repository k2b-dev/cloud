import { DataTable, type DataTableColumn, Pagination, StatCell, StatGrid } from "@k2b/ui";
import { listApps } from "@k2b/cloud";
import { createPagination, hasRole, type NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
import { ssr } from "../../config";
import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import DeliveryFilterBar from "./_components/DeliveryFilterBar.island";
import {
  buildDeliveryNotificationsUrl,
  buildLegacyNotificationsUrl,
  buildRegistryNotificationsUrl,
  type NotificationAppFilterOption,
  notificationChannelIcon,
  notificationChannelLabel,
  parseDeliveryStatus,
  parseFilterList,
  parseLegacyStatus,
  parseNotificationAdminView,
  parseRegistryStatus,
} from "./_components/filter-state";
import NotificationActions from "./_components/NotificationActions.island";
import NotificationFilterBar from "./_components/NotificationFilterBar.island";
import NotificationViewSwitch from "./_components/NotificationViewSwitch.island";
import RegistryFilterBar from "./_components/RegistryFilterBar.island";
import { notificationsService } from "./service";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../../messages";

type DeliveryItem = Awaited<ReturnType<typeof notificationsService.delivery.list>>["items"][number];
type RegistryItem = Awaited<ReturnType<typeof notificationsService.registry.list>>["items"][number];
type LegacyItem = Awaited<ReturnType<typeof notificationsService.notification.list>>["items"][number];

const parsePage = (value: string | undefined): number => {
  const parsed = Number(value ?? "1");
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1;
};

const paginationBase = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}page=`;

const channelChip = (channel: string, t: GatewayOpsMessages): JSX.Element => {
  const tone =
    channel === "email"
      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"
      : channel === "browser"
        ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
  return (
    <span class={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium ${tone}`}>
      <i class={`${notificationChannelIcon(channel)} text-xs`} />
      {channel === "email" ? t.email : channel === "browser" ? t.browser : notificationChannelLabel(channel)}
    </span>
  );
};

const deliveryStatusBadge = (status: NotificationDeliveryStatus, t: GatewayOpsMessages): JSX.Element => {
  const config = {
    deferred: { label: t.deferred, icon: "ti ti-player-pause", tone: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" },
    pending: { label: t.pending, icon: "ti ti-clock", tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200" },
    sending: { label: t.sending, icon: "ti ti-send", tone: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" },
    delivered: {
      label: t.delivered,
      icon: "ti ti-check",
      tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
    },
    suppressed: { label: t.suppressed, icon: "ti ti-bell-off", tone: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" },
    failed: { label: t.failed, icon: "ti ti-alert-circle", tone: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" },
  }[status];
  return (
    <span class={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium ${config.tone}`}>
      <i class={`${config.icon} text-xs`} />
      {config.label}
    </span>
  );
};

const legacyStatusBadge = (status: LegacyItem["status"], t: GatewayOpsMessages): JSX.Element => {
  if (status === "sent") return deliveryStatusBadge("delivered", t);
  if (status === "error") return deliveryStatusBadge("failed", t);
  return deliveryStatusBadge("pending", t);
};

const buildAppOptions = (appIds: string[], liveApps: Awaited<ReturnType<typeof listApps>>): NotificationAppFilterOption[] => {
  const liveById = new Map(liveApps.map((app) => [app.id, app]));
  return appIds.map((id) => {
    const app = liveById.get(id);
    return { id, label: app?.name ?? id, icon: app?.icon ?? "ti ti-apps" };
  });
};

const appCell = (appId: string, appById: ReadonlyMap<string, NotificationAppFilterOption>): JSX.Element => {
  const app = appById.get(appId);
  return (
    <span class="inline-flex min-w-0 items-center gap-1.5" title={appId}>
      <i class={`${app?.icon ?? "ti ti-apps"} shrink-0 text-sm text-dimmed`} />
      <span class="truncate">{app?.label ?? appId}</span>
    </span>
  );
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  const isAdmin = hasRole(user, "admin");
  const view = parseNotificationAdminView(c.req.query("view") ?? undefined);
  const page = parsePage(c.req.query("page") ?? undefined);
  const perPage = 100;
  const search = (c.req.query("search") ?? "").trim();

  const renderPage = (description: string, content: JSX.Element) => () => (
    <AdminLayout c={c} title={t.notifications}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-notifications-title">
          <h1 class="text-base font-semibold text-primary">{t.notifications}</h1>
          <p class="mt-1 text-xs text-dimmed">{description}</p>
        </div>
        <div class="self-start">
          <NotificationViewSwitch view={view} />
        </div>
        {content}
      </div>
    </AdminLayout>
  );

  if (view === "deliveries") {
    const status = parseDeliveryStatus(c.req.query("status") ?? undefined);
    const channels = parseFilterList(c.req.query("channels") ?? undefined);
    const appIds = parseFilterList(c.req.query("apps") ?? undefined);
    const deliveryFilter = {
      search: search || undefined,
      statuses: status === "all" ? undefined : [status],
      channels,
      appIds,
    };
    const [result, summary, timeseries, facets, liveApps] = await Promise.all([
      notificationsService.delivery.list({
        page,
        perPage,
        filter: deliveryFilter,
      }),
      notificationsService.delivery.summary({ days: 7, filter: deliveryFilter }),
      notificationsService.delivery.timeseries({ days: 7, filter: deliveryFilter }),
      notificationsService.facets(),
      listApps().catch(() => []),
    ]);
    const appOptions = buildAppOptions(facets.appIds, liveApps);
    const appById = new Map(appOptions.map((app) => [app.id, app]));
    const pagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, result.total);
    const baseUrl = paginationBase(buildDeliveryNotificationsUrl({ search, status, channels, appIds }));
    const deliverySeries = (
      [
        [t.delivered, "delivered"],
        [t.active, "active"],
        [t.suppressed, "suppressed"],
        [t.failed, "failed"],
      ] as const
    )
      .filter(([, outcome]) => {
        if (status === "all") return true;
        if (status === "deferred" || status === "pending" || status === "sending") return outcome === "active";
        return outcome === status;
      })
      .map(([label, outcome]) => ({
        label,
        data: timeseries.map((point) => ({ x: point.at.getTime(), y: point[outcome] })),
      }));
    const columns: DataTableColumn<DeliveryItem>[] = [
      { id: "status", header: t.status, value: (item) => item.status },
      { id: "notification", header: t.notification, value: (item) => item.title, cellClass: "max-w-[24rem]" },
      { id: "app", header: t.app, value: (item) => appById.get(item.appId)?.label ?? item.appId },
      { id: "recipient", header: t.recipient, value: (item) => item.recipientLabel, cellClass: "max-w-[18rem]" },
      { id: "channel", header: t.channel, value: (item) => item.channel },
      { id: "attempts", header: t.attempts, value: (item) => item.attemptCount, cellClass: "text-right tabular-nums" },
      { id: "created", header: t.created, value: (item) => item.createdAt, cellClass: "whitespace-nowrap" },
    ];

    return renderPage(
      t.deliveryDescriptionPage,
      <>
        <StatGrid columns={4}>
          <StatCell
            label={t.failed7d}
            value={formatNumber(summary.failed, { locale })}
            sub={summary.total > 0 ? t.totalCount({ count: formatNumber(summary.total, { locale }) }) : t.none}
            valueClass={summary.failed > 0 ? "text-red-500" : "text-primary"}
            accent={summary.failed > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
          <StatCell
            label={t.active7d}
            value={formatNumber(summary.active, { locale })}
            sub={t.activeDeliveryStates}
            valueClass={summary.active > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={summary.active > 0 ? { tone: "amber", icon: "ti ti-clock" } : undefined}
          />
          <StatCell
            label={t.delivered7d}
            value={formatNumber(summary.delivered, { locale })}
            sub={t.providerAccepted}
            accent={{ tone: "emerald", icon: "ti ti-check" }}
          />
          <StatCell label={t.suppressed7d} value={formatNumber(summary.suppressed, { locale })} sub={t.policyOrFallback} />
        </StatGrid>

        <section class="paper p-3">
          <h2 class="text-xs font-semibold text-primary">{t.deliveryOutcomes}</h2>
          <p class="text-[10px] text-dimmed">{t.deliveryOutcomesDescription}</p>
          <ObservabilityChart
            kind="line"
            class="mt-2 h-64 w-full text-dimmed"
            series={deliverySeries}
            xFormat="timeline"
            yFormat="number"
            legend
            interactive
          />
        </section>

        <section class="paper overflow-hidden" style="view-transition-name: admin-notification-deliveries-table">
          <div class="flex flex-col gap-2 px-3 py-2">
            <div>
              <h2 class="text-xs font-semibold text-primary">{t.deliveryAttempts}</h2>
              <p class="text-[10px] text-dimmed">{t.attemptsCount({ count: result.items.length, total: result.total })}</p>
            </div>
            <DeliveryFilterBar
              search={search}
              status={status}
              channels={channels}
              appIds={appIds}
              channelOptions={facets.channels}
              appOptions={appOptions}
            />
          </div>
          <DataTable
            rows={result.items}
            columns={columns}
            getRowId={(item) => item.id}
            hoverRows
            class="overflow-x-auto"
            empty={search ? t.noMatchingDeliveryAttempts : t.noDeliveryAttempts}
            renderCell={({ row: item, col }) => {
              if (col.id === "status") return deliveryStatusBadge(item.status, t);
              if (col.id === "notification") {
                return (
                  <div class="min-w-0">
                    <p class="truncate font-medium text-primary" title={item.title}>
                      {item.title}
                    </p>
                    <p class="truncate text-[10px] text-dimmed" title={item.definitionId}>
                      {item.label}
                    </p>
                    {item.errorCode && (
                      <p class="truncate text-[10px] text-red-500" title={item.errorMessage ?? item.errorCode}>
                        {item.errorCode}
                      </p>
                    )}
                  </div>
                );
              }
              if (col.id === "app") return appCell(item.appId, appById);
              if (col.id === "recipient") {
                return (
                  <div class="min-w-0">
                    <p class="truncate text-primary" title={item.recipientLabel}>
                      {item.recipientLabel}
                    </p>
                    {item.recipientReference !== item.recipientLabel && (
                      <p class="truncate font-mono text-[10px] text-dimmed" title={item.recipientReference}>
                        {item.recipientReference}
                      </p>
                    )}
                  </div>
                );
              }
              if (col.id === "channel") {
                return (
                  <div class="flex flex-wrap items-center gap-1">
                    {channelChip(item.channel, t)}
                    {item.required && <span class="text-[9px] font-medium uppercase text-dimmed">{t.required}</span>}
                  </div>
                );
              }
              if (col.id === "attempts") return formatNumber(item.attemptCount, { locale });
              if (col.id === "created") return <span class="text-dimmed">{formatDateTime(item.createdAt, dateConfig)}</span>;
              return "";
            }}
          />
        </section>
        <Pagination currentPage={pagination.page} totalPages={pagination.total_pages} baseUrl={baseUrl} />
      </>,
    );
  }

  if (view === "registry") {
    const status = parseRegistryStatus(c.req.query("status") ?? undefined);
    const appIds = parseFilterList(c.req.query("apps") ?? undefined);
    const [result, summary, facets, liveApps] = await Promise.all([
      notificationsService.registry.list({
        page,
        perPage,
        filter: { search: search || undefined, appIds, active: status === "all" ? undefined : status === "active" },
      }),
      notificationsService.registry.summary(),
      notificationsService.facets(),
      listApps().catch(() => []),
    ]);
    const appOptions = buildAppOptions(facets.appIds, liveApps);
    const appById = new Map(appOptions.map((app) => [app.id, app]));
    const pagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, result.total);
    const baseUrl = paginationBase(buildRegistryNotificationsUrl({ search, status, appIds }));
    const columns: DataTableColumn<RegistryItem>[] = [
      { id: "app", header: t.app, value: (item) => appById.get(item.appId)?.label ?? item.appId },
      { id: "notification", header: t.notification, value: (item) => item.label, cellClass: "max-w-[28rem]" },
      { id: "recipient", header: t.recipient, value: (item) => item.recipientKind },
      { id: "recommended", header: t.recommended, value: (item) => item.recommendedChannels.join(", ") },
      { id: "required", header: t.required, value: (item) => item.requiredChannels.join(", ") },
      { id: "events", header: t.events7d, value: (item) => item.eventCount7d, cellClass: "text-right tabular-nums" },
      { id: "failures", header: t.failures7d, value: (item) => item.failedDeliveryCount7d, cellClass: "text-right tabular-nums" },
      { id: "seen", header: t.lastSeenLabel, value: (item) => item.lastSeenAt, cellClass: "whitespace-nowrap" },
      { id: "state", header: t.state, value: (item) => item.active },
    ];

    return renderPage(
      t.registryDescription,
      <>
        <StatGrid columns={4}>
          <StatCell label={t.definitions} value={formatNumber(summary.total, { locale })} sub={t.durableCatalog} />
          <StatCell
            label={t.active}
            value={formatNumber(summary.active, { locale })}
            sub={t.latestAppCatalogs}
            accent={{ tone: "emerald", icon: "ti ti-check" }}
          />
          <StatCell label={t.apps} value={formatNumber(summary.apps, { locale })} sub={t.registeredCatalogs} />
          <StatCell
            label={t.required}
            value={formatNumber(summary.required, { locale })}
            sub={t.userLockedDelivery}
            accent={{ tone: "amber", icon: "ti ti-lock" }}
          />
        </StatGrid>

        <section class="paper overflow-hidden" style="view-transition-name: admin-notification-registry-table">
          <div class="flex flex-col gap-2 px-3 py-2">
            <div>
              <h2 class="text-xs font-semibold text-primary">{t.registeredNotificationKinds}</h2>
              <p class="text-[10px] text-dimmed">{t.definitionsCount({ count: result.items.length, total: result.total })}</p>
            </div>
            <RegistryFilterBar search={search} status={status} appIds={appIds} appOptions={appOptions} />
          </div>
          <DataTable
            rows={result.items}
            columns={columns}
            getRowId={(item) => item.id}
            hoverRows
            class="overflow-x-auto"
            empty={search ? t.noMatchingRegisteredNotifications : t.noRegisteredDefinitions}
            renderCell={({ row: item, col }) => {
              if (col.id === "app") return appCell(item.appId, appById);
              if (col.id === "notification") {
                return (
                  <div class="min-w-0">
                    <p class="truncate font-medium text-primary" title={item.label}>
                      {item.label}
                    </p>
                    <p class="truncate text-[10px] text-dimmed" title={item.description}>
                      {item.description}
                    </p>
                    <p class="truncate font-mono text-[9px] text-dimmed" title={item.id}>
                      {item.kind}
                    </p>
                  </div>
                );
              }
              if (col.id === "recipient") {
                return (
                  <span class="inline-flex items-center gap-1 text-xs capitalize text-secondary">
                    <i class={item.recipientKind === "email" ? "ti ti-mail" : "ti ti-user"} />
                    {item.recipientKind}
                  </span>
                );
              }
              if (col.id === "recommended") {
                return item.recommendedChannels.length > 0 ? (
                  <div class="flex flex-wrap gap-1">{item.recommendedChannels.map((channel) => channelChip(channel, t))}</div>
                ) : (
                  <span class="text-dimmed">-</span>
                );
              }
              if (col.id === "required") {
                return item.requiredChannels.length > 0 ? (
                  <div class="flex flex-wrap gap-1">{item.requiredChannels.map((channel) => channelChip(channel, t))}</div>
                ) : (
                  <span class="text-dimmed">-</span>
                );
              }
              if (col.id === "events") return formatNumber(item.eventCount7d, { locale });
              if (col.id === "failures") {
                return (
                  <span class={item.failedDeliveryCount7d > 0 ? "text-red-500" : "text-dimmed"}>
                    {formatNumber(item.failedDeliveryCount7d, { locale })}
                  </span>
                );
              }
              if (col.id === "seen") return <span class="text-dimmed">{formatDateTime(item.lastSeenAt, dateConfig)}</span>;
              if (col.id === "state") {
                return item.active ? (
                  <span class="inline-flex h-6 items-center gap-1 rounded-full bg-emerald-100 px-2 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                    <i class="ti ti-check" />
                    {t.active}
                  </span>
                ) : (
                  <span class="inline-flex h-6 items-center gap-1 rounded-full bg-zinc-100 px-2 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                    <i class="ti ti-archive" />
                    {t.inactive}
                  </span>
                );
              }
              return "";
            }}
          />
        </section>
        <Pagination currentPage={pagination.page} totalPages={pagination.total_pages} baseUrl={baseUrl} />
      </>,
    );
  }

  const status = parseLegacyStatus(c.req.query("status") ?? undefined);
  const [{ items, total }, summary, searchSummary] = await Promise.all([
    notificationsService.notification.list({
      pagination: { page, perPage },
      access: { isAdmin, sentBy: user.id, search: search || undefined, status: status === "all" ? undefined : status },
    }),
    notificationsService.notification.summary({ access: { isAdmin, sentBy: user.id }, days: 7 }),
    search ? notificationsService.notification.searchSummary({ access: { isAdmin, sentBy: user.id }, search }) : Promise.resolve(null),
  ]);
  const pagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, total);
  const baseUrl = paginationBase(buildLegacyNotificationsUrl({ search, status }));
  const columns: DataTableColumn<LegacyItem>[] = [
    { id: "status", header: t.status, value: (item) => item.status },
    { id: "recipient", header: t.recipient, value: (item) => item.recipient, cellClass: "font-mono text-[11px]" },
    { id: "subject", header: t.subject, value: (item) => item.subject, cellClass: "max-w-[28rem]" },
    { id: "sentBy", header: t.sentBy, value: (item) => item.sentByName },
    { id: "created", header: t.created, value: (item) => item.createdAt, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: <span class="sr-only">{t.actions}</span>,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap",
    },
  ];

  return renderPage(
    t.legacyNotificationsDescription,
    <>
      <StatGrid columns={3}>
        <StatCell
          label={t.errors7d}
          value={formatNumber(summary.error, { locale })}
          sub={summary.error > 0 ? t.last7Days : t.none}
          valueClass={summary.error > 0 ? "text-red-500" : "text-primary"}
          accent={summary.error > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell
          label={t.pending7d}
          value={formatNumber(summary.pending, { locale })}
          sub={summary.pending > 0 ? t.last7Days : t.none}
          valueClass={summary.pending > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
          accent={summary.pending > 0 ? { tone: "amber", icon: "ti ti-clock" } : undefined}
        />
        <StatCell label={t.sent7d} value={formatNumber(summary.sent, { locale })} sub={t.last7Days} accent={{ tone: "emerald", icon: "ti ti-check" }} />
      </StatGrid>

      <section class="paper overflow-hidden" style="view-transition-name: admin-notification-legacy-table">
        <div class="flex flex-col gap-2 px-3 py-2">
          <div>
            <h2 class="text-xs font-semibold text-primary">{t.legacyEmailEntries}</h2>
            <p class="text-[10px] text-dimmed">{t.entriesCount({ count: items.length, total })}</p>
          </div>
          <NotificationFilterBar search={search} status={status} />
          {searchSummary && (
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="inline-flex h-7 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                <i class="ti ti-search text-sm" />
                {t.matches({ count: formatNumber(searchSummary.total, { locale }) })}
              </span>
              <span
                class={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${searchSummary.error > 0 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}
              >
                <i class="ti ti-alert-circle text-sm" />
                {t.errorCountLabel({ count: formatNumber(searchSummary.error, { locale }) })}
              </span>
              <span class="inline-flex h-7 items-center gap-1.5 rounded-full bg-amber-100 px-2.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
                <i class="ti ti-clock text-sm" />
                {t.pendingCountLabel({ count: formatNumber(searchSummary.pending, { locale }) })}
              </span>
            </div>
          )}
        </div>
        <DataTable
          rows={items}
          columns={columns}
          getRowId={(item) => item.id}
          hoverRows
          class="overflow-x-auto"
          empty={search ? t.noMatchingLegacyNotifications : t.noLegacyNotifications}
          renderCell={({ row: item, col }) => {
            if (col.id === "status") return legacyStatusBadge(item.status, t);
            if (col.id === "recipient") return item.recipient;
            if (col.id === "subject")
              return <span title={item.error ? `${item.subject} · ${item.error}` : item.subject}>{item.subject}</span>;
            if (col.id === "sentBy") return <span class="text-dimmed">{item.sentByName ?? <span class="italic">{t.system}</span>}</span>;
            if (col.id === "created") return <span class="text-dimmed">{formatDateTime(item.createdAt, dateConfig)}</span>;
            if (col.id === "actions") {
              return (
                <NotificationActions
                  id={item.id}
                  status={item.status}
                  subject={item.subject}
                  content={item.content}
                  recipient={item.recipient}
                  error={item.error}
                  isAdmin={isAdmin}
                />
              );
            }
            return "";
          }}
        />
      </section>
      <Pagination currentPage={pagination.page} totalPages={pagination.total_pages} baseUrl={baseUrl} />
    </>,
  );
});
