import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Placeholder } from "@k2b/ui";
import type { NotificationDeliveryStatus, UserNotificationHistoryItem } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { notifications } from "@valentinkolb/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountSubnav, notificationViews } from "./AccountHub";
import NotificationHistoryFilters from "./NotificationHistoryFilters.island";
import { notificationChannelMeta, notificationStatusMeta } from "./notification-ui";

const historyStatuses = new Set<NotificationDeliveryStatus>(["deferred", "pending", "sending", "delivered", "suppressed", "failed"]);

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const columns: DataTableColumn<UserNotificationHistoryItem>[] = [
  { id: "time", header: "Time", value: (item) => item.createdAt, cellClass: "whitespace-nowrap" },
  { id: "notification", header: "Notification", value: (item) => item.title, cellClass: "min-w-[13rem]" },
  { id: "channel", header: "Channel", value: (item) => item.channel, cellClass: "min-w-[9rem]" },
  { id: "status", header: "Status", value: (item) => item.status, cellClass: "min-w-[12rem]" },
];

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
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
        { title: "Start", href: "/" },
        { title: "Account", href: "/me" },
        { title: "Notifications", href: "/me/notifications" },
        { title: "Delivery history" },
      ]}
    >
      <AccountHub user={user} active="notifications">
        <div class="flex flex-col gap-2">
          <AccountPageHeader
            title="Delivery history"
            description="Review notification outcomes without exposing message contents."
            actions={<AccountSubnav active="history" items={notificationViews} />}
          />

          <section class="paper p-5 sm:p-6">
            <div class="mb-5 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold text-primary">Recent deliveries</h3>
                <p class="mt-1 text-xs text-dimmed">Metadata only; notification contents are not shown here.</p>
              </div>
              <NotificationHistoryFilters status={status} />
            </div>

            {history.items.length === 0 ? (
              <Placeholder description={<>No notification deliveries found.</>} />
            ) : (
              <DataTable
                rows={history.items}
                columns={columns}
                getRowId={(item) => item.id}
                density="compact"
                highlightColumns={false}
                class="max-h-[34rem] overflow-auto"
                tableClass="w-full min-w-[46rem] text-xs"
                renderCell={({ row: item, col, render }) => {
                  if (col.id === "time") return <span class="text-dimmed">{dates.formatDateTime(item.createdAt)}</span>;
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
                    const channel = notificationChannelMeta(item.channel);
                    return (
                      <div>
                        <span class="inline-flex items-center gap-1.5 text-secondary">
                          <i class={channel.icon} />
                          {channel.label}
                        </span>
                        <p class="mt-0.5 text-[11px] text-dimmed">{item.destinationLabel}</p>
                      </div>
                    );
                  }
                  if (col.id === "status") {
                    const delivery = notificationStatusMeta(item.status);
                    return (
                      <div>
                        <span class={`tag ${delivery.class}`}>{delivery.label}</span>
                        {item.errorMessage && <p class="mt-1 max-w-xs text-[11px] leading-snug text-dimmed">{item.errorMessage}</p>}
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
