import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Placeholder } from "@k2b/ui";
import type { NotificationDeliveryStatus, UserNotificationHistoryItem } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { notifications } from "@valentinkolb/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountSubnav, notificationViews } from "./AccountHub";
import { type AccountMessages, accountMessages } from "./messages";
import NotificationHistoryFilters from "./NotificationHistoryFilters.island";
import { notificationChannelMeta, notificationErrorText, notificationStatusMeta } from "./notification-ui";

const historyStatuses = new Set<NotificationDeliveryStatus>(["deferred", "pending", "sending", "delivered", "suppressed", "failed"]);

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const columns = (t: AccountMessages): DataTableColumn<UserNotificationHistoryItem>[] => [
  { id: "time", header: t.time, value: (item) => item.createdAt, cellClass: "whitespace-nowrap" },
  { id: "notification", header: t.notification, value: (item) => item.title, cellClass: "min-w-[13rem]" },
  { id: "channel", header: t.channel, value: (item) => item.channel, cellClass: "min-w-[9rem]" },
  { id: "status", header: t.status, value: (item) => item.status, cellClass: "min-w-[12rem]" },
];

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const page = parsePositiveInt(c.req.query("page"), 1);
  const rawStatus = c.req.query("status");
  const status =
    rawStatus && historyStatuses.has(rawStatus as NotificationDeliveryStatus) ? (rawStatus as NotificationDeliveryStatus) : undefined;
  const history = await notifications.user.history.list({ userId: user.id, page, perPage: 25, status });
  const registeredApps = getLocalizedRuntimeContext(c).apps;
  const appNames = new Map(registeredApps.map((app) => [app.id, app.name]));
  const baseUrl = status ? `/me/notifications/history?status=${encodeURIComponent(status)}&page=` : "/me/notifications/history?page=";

  return () => (
    <Layout
      c={c}
      title={[
        { title: t.start, href: "/" },
        { title: t.account, href: "/me" },
        { title: t.notifications, href: "/me/notifications" },
        { title: t.deliveryHistory },
      ]}
    >
      <AccountHub user={user} active="notifications">
        <div class="flex flex-col gap-2">
          <AccountPageHeader
            title={t.deliveryHistory}
            description={t.deliveryHistoryDescription}
            actions={<AccountSubnav active="history" items={notificationViews(locale)} />}
          />

          <section class="paper p-5 sm:p-6">
            <div class="mb-5 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold text-primary">{t.recentDeliveries}</h3>
                <p class="mt-1 text-xs text-dimmed">{t.deliveryMetadataOnly}</p>
              </div>
              <NotificationHistoryFilters status={status} />
            </div>

            {history.items.length === 0 ? (
              <Placeholder description={<>{t.noNotificationDeliveries}</>} />
            ) : (
              <DataTable
                rows={history.items}
                columns={columns(t)}
                getRowId={(item) => item.id}
                density="compact"
                highlightColumns={false}
                class="max-h-[34rem] overflow-auto"
                tableClass="w-full min-w-[46rem] text-xs"
                renderCell={({ row: item, col, render }) => {
                  if (col.id === "time") return <span class="text-dimmed">{dates.formatDateTime(item.createdAt, { locale })}</span>;
                  if (col.id === "notification")
                    return (
                      <div class="min-w-0">
                        {item.targetHref ? (
                          <a href={item.targetHref} class="font-medium text-primary hover:underline">
                            {item.title}
                          </a>
                        ) : (
                          <span class="font-medium text-primary">{item.title}</span>
                        )}
                        <p class="mt-0.5 text-[11px] text-dimmed">
                          {appNames.get(item.appId) ?? item.appId} · {item.label}
                        </p>
                      </div>
                    );
                  if (col.id === "channel") {
                    const channel = notificationChannelMeta(item.channel, locale);
                    return (
                      <div>
                        <span class="inline-flex items-center gap-1.5 text-secondary">
                          <i class={channel.icon} />
                          {channel.label}
                        </span>
                        <p class="mt-0.5 text-[11px] text-dimmed">
                          {item.channel === "none" ? t.noDeliveryChannel : item.destinationLabel}
                        </p>
                      </div>
                    );
                  }
                  if (col.id === "status") {
                    const delivery = notificationStatusMeta(item.status, locale);
                    const error = notificationErrorText(item.errorCode, item.errorMessage, locale);
                    return (
                      <div>
                        <span class={`tag ${delivery.class}`}>{delivery.label}</span>
                        {error && <p class="mt-1 max-w-xs text-[11px] leading-snug text-dimmed">{error}</p>}
                      </div>
                    );
                  }
                  return render(item);
                }}
              />
            )}
            <Pagination currentPage={history.page} totalPages={history.totalPages} baseUrl={baseUrl} />
          </section>
        </div>
      </AccountHub>
    </Layout>
  );
});
