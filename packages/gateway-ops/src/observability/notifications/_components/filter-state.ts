import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";

export const NOTIFICATION_ADMIN_BASE_URL = "/admin/observability/notifications";

export type NotificationAdminView = "deliveries" | "registry" | "legacy";
export type DeliveryStatusFilter = "all" | NotificationDeliveryStatus;
export type RegistryStatusFilter = "all" | "active" | "inactive";
export type LegacyNotificationStatusFilter = "all" | "sent" | "pending" | "error";
export type NotificationAppFilterOption = { id: string; label: string; icon: string };

const DELIVERY_STATUSES = new Set<DeliveryStatusFilter>(["all", "deferred", "pending", "sending", "delivered", "suppressed", "failed"]);
const REGISTRY_STATUSES = new Set<RegistryStatusFilter>(["all", "active", "inactive"]);
const LEGACY_STATUSES = new Set<LegacyNotificationStatusFilter>(["all", "sent", "pending", "error"]);

export const parseNotificationAdminView = (value: string | undefined): NotificationAdminView =>
  value === "registry" || value === "legacy" ? value : "deliveries";

export const parseDeliveryStatus = (value: string | undefined): DeliveryStatusFilter =>
  value && DELIVERY_STATUSES.has(value as DeliveryStatusFilter) ? (value as DeliveryStatusFilter) : "all";

export const parseRegistryStatus = (value: string | undefined): RegistryStatusFilter =>
  value && REGISTRY_STATUSES.has(value as RegistryStatusFilter) ? (value as RegistryStatusFilter) : "all";

export const parseLegacyStatus = (value: string | undefined): LegacyNotificationStatusFilter =>
  value && LEGACY_STATUSES.has(value as LegacyNotificationStatusFilter) ? (value as LegacyNotificationStatusFilter) : "all";

export const parseFilterList = (value: string | undefined): string[] =>
  [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);

export const notificationChannelLabel = (channel: string): string => {
  if (channel === "email") return "Email";
  if (channel === "browser") return "Browser";
  if (channel === "none") return "No channel";
  return channel;
};

export const notificationChannelIcon = (channel: string): string => {
  if (channel === "email") return "ti ti-mail";
  if (channel === "browser") return "ti ti-bell";
  if (channel === "none") return "ti ti-bell-off";
  return "ti ti-route";
};

export const buildNotificationViewUrl = (view: NotificationAdminView): string =>
  view === "deliveries" ? NOTIFICATION_ADMIN_BASE_URL : `${NOTIFICATION_ADMIN_BASE_URL}?view=${view}`;

export const buildDeliveryNotificationsUrl = (filter: {
  search: string;
  status: DeliveryStatusFilter;
  channels: string[];
  appIds: string[];
  page?: number;
}): string => {
  const params = new URLSearchParams();
  if (filter.search.trim()) params.set("search", filter.search.trim());
  if (filter.status !== "all") params.set("status", filter.status);
  if (filter.channels.length > 0) params.set("channels", filter.channels.join(","));
  if (filter.appIds.length > 0) params.set("apps", filter.appIds.join(","));
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  const query = params.toString();
  return query ? `${NOTIFICATION_ADMIN_BASE_URL}?${query}` : NOTIFICATION_ADMIN_BASE_URL;
};

export const buildRegistryNotificationsUrl = (filter: {
  search: string;
  status: RegistryStatusFilter;
  appIds: string[];
  page?: number;
}): string => {
  const params = new URLSearchParams({ view: "registry" });
  if (filter.search.trim()) params.set("search", filter.search.trim());
  if (filter.status !== "all") params.set("status", filter.status);
  if (filter.appIds.length > 0) params.set("apps", filter.appIds.join(","));
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  return `${NOTIFICATION_ADMIN_BASE_URL}?${params.toString()}`;
};

export const buildLegacyNotificationsUrl = (filter: { search: string; status: LegacyNotificationStatusFilter; page?: number }): string => {
  const params = new URLSearchParams({ view: "legacy" });
  if (filter.search.trim()) params.set("search", filter.search.trim());
  if (filter.status !== "all") params.set("status", filter.status);
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  return `${NOTIFICATION_ADMIN_BASE_URL}?${params.toString()}`;
};
