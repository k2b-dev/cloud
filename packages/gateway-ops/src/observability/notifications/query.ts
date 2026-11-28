/**
 * The two notification lists' declarations: the definitions apps register (`tab=registry`) and the earlier
 * notifications sent before the delivery pipeline (`tab=legacy`). Deliveries themselves are runs. The SSR page reads
 * the address only through these.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { gatewayOpsMessages } from "../../messages";

export const NOTIFICATIONS_PATH = "/admin/observability/deliveries";
export const NOTIFICATIONS_PER_PAGE = 100;
export const NOTIFICATIONS_PAGE_MAX = 1000;
export const NOTIFICATIONS_SEARCH_MAX = 200;

export type NotificationsView = "registry" | "legacy";

export const registryQuery = (locale: string, apps: readonly { id: string; label: string }[]) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.notification-definitions",
    fields: {
      status: field.choice({
        label: t.state,
        common: true,
        multiple: false,
        options: [
          { value: "active", label: t.active },
          { value: "inactive", label: t.inactive },
        ],
      }),
      app: field.choice({
        label: t.app,
        common: true,
        options: apps.filter((app) => app.id !== "" && !app.id.includes(",")).map((app) => ({ value: app.id, label: app.label })),
      }),
    },
    search: { label: t.search },
    sort: { fixed: { field: "app", direction: "asc", label: t.app } },
    pageParams: ["tab", "page"],
  });
};

export const legacyQuery = (locale: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.legacy-notifications",
    fields: {
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: [
          { value: "error", label: t.failed },
          { value: "pending", label: t.pending },
          { value: "sent", label: t.sent },
        ],
      }),
    },
    search: { label: t.search },
    sort: { fixed: { field: "created", direction: "desc", label: t.created } },
    pageParams: ["tab", "page", "notification"],
  });
};

export type RegistryQuery = ReturnType<typeof registryQuery>;
export type RegistryState = ListQueryStateOf<RegistryQuery>;
export type LegacyQuery = ReturnType<typeof legacyQuery>;
export type LegacyState = ListQueryStateOf<LegacyQuery>;

/** The address of a view's state on a page. */
export const notificationsHref = (view: NotificationsView, params: URLSearchParams, page = 1) => {
  const next = new URLSearchParams(params);
  next.set("tab", view);
  if (page > 1) next.set("page", String(page));
  else next.delete("page");
  return `${NOTIFICATIONS_PATH}?${next.toString().replace(/%(?:2C|3A|2F|40)/gi, decodeURIComponent)}`;
};

/**
 * Addresses from before v2 (`view=registry`, `search=`, `apps=a,b`, `status=all`) lead to the same list in the v2
 * address. Null when the address already reads as v2 (or is no list of this page).
 */
export const legacyNotificationsHref = (params: URLSearchParams): string | null => {
  const view = params.get("tab") ?? params.get("view");
  if (view !== "registry" && view !== "legacy") return null;
  if (!params.has("view") && !params.has("search") && !params.has("apps") && params.get("status") !== "all") return null;
  const next = new URLSearchParams({ tab: view });
  for (const [name, value] of params) {
    if (name === "view" || name === "tab") continue;
    if (name === "search") {
      if (value.trim() && !params.has("q")) next.set("q", value.trim());
    } else if (name === "apps") {
      if (value && view === "registry" && !params.has("app")) next.set("app", value);
    } else if (!(name === "status" && value === "all")) next.append(name, value);
  }
  return `${NOTIFICATIONS_PATH}?${next.toString().replace(/%(?:2C|3A|2F|40)/gi, decodeURIComponent)}`;
};
