import { listApps } from "@k2b/cloud";
import { hasRole } from "@k2b/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDateTime } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import { observabilityAdminNav } from "../_components/admin-nav";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, readAttention } from "../_components/ObservabilityArea";
import NotificationsScreen from "./_components/NotificationsScreen.island";
import { legacyQuery, NOTIFICATIONS_PAGE_MAX, NOTIFICATIONS_PER_PAGE, NOTIFICATIONS_SEARCH_MAX, registryQuery } from "./query";
import { notificationsService } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Notifications on v2: the definitions apps register (`tab=registry`) and the notifications sent before the delivery
 * pipeline (`tab=legacy`). The router sends every other address of this path to the deliveries in Runs.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const user = expectUserBackedActor(c);
  const params = new URL(c.req.url).searchParams;
  const view = params.get("tab") === "legacy" ? "legacy" : "registry";
  const rawPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= NOTIFICATIONS_PAGE_MAX ? rawPage : 1;
  const paging = { page, perPage: NOTIFICATIONS_PER_PAGE, offset: (page - 1) * NOTIFICATIONS_PER_PAGE };
  const number = (value: number) => value.toLocaleString(locale);
  const bounded = <S extends { search?: string }>(state: S): S =>
    state.search && state.search.length > NOTIFICATIONS_SEARCH_MAX ? { ...state, search: undefined } : state;

  const [registered, attention] = await Promise.all([listApps().catch(() => []), readAttention()]);
  const apps = registered.map((app) => ({ id: app.id, label: app.name || app.id, icon: app.icon?.replace(/^ti\s+(ti-)?/, "") || "apps" }));
  const appOf = (id: string) => apps.find((app) => app.id === id) ?? { id, label: id, icon: "apps" };

  const registry =
    view === "registry"
      ? await (async () => {
          const state = bounded(registryQuery(locale, apps).parse(params).state);
          const [result, summary] = await Promise.all([
            notificationsService.registry.list({
              page,
              perPage: NOTIFICATIONS_PER_PAGE,
              filter: {
                search: state.search,
                appIds: state.filters.app ?? [],
                active: state.filters.status ? state.filters.status === "active" : undefined,
              },
            }),
            notificationsService.registry.summary(),
          ]);
          const cells: KeyCell[] = [
            { icon: "list-details", label: t.definitions, value: number(summary.total), meta: t.durableCatalog },
            { icon: "circle-check", label: t.activeDefinitions, value: number(summary.active), meta: t.latestAppCatalogs },
            { icon: "apps", label: t.apps, value: number(summary.apps), meta: t.registeredCatalogs },
            { icon: "lock", label: t.required, value: number(summary.required), meta: t.userLockedDelivery },
          ];
          return {
            state,
            total: result.total,
            cells,
            rows: result.items.map((item) => ({
              id: item.id,
              label: item.label,
              description: item.description,
              kind: item.kind,
              app: appOf(item.appId),
              recipientKind: item.recipientKind,
              recommended: item.recommendedChannels,
              required: item.requiredChannels,
              events: number(item.eventCount7d),
              failures: item.failedDeliveryCount7d,
              lastSeen: item.lastSeenAt ? formatDateTime(item.lastSeenAt, dateConfig) : "—",
              active: item.active,
            })),
          };
        })()
      : null;

  const legacy =
    view === "legacy"
      ? await (async () => {
          const state = bounded(legacyQuery(locale).parse(params).state);
          const access = { isAdmin: hasRole(user, "admin"), sentBy: user.id };
          // the open notification is read on its own, so it stays open when it no longer matches the list's filter or page
          const id = params.get("notification");
          const [result, summary, pendingSystem, searchSummary, opened] = await Promise.all([
            notificationsService.notification.list({
              pagination: paging,
              access: { ...access, search: state.search, status: state.filters.status },
            }),
            notificationsService.notification.summary({ access, days: 7 }),
            notificationsService.system.pendingCount(),
            state.search ? notificationsService.notification.searchSummary({ access, search: state.search }) : null,
            id && UUID.test(id) ? notificationsService.notification.get({ id }) : null,
          ]);
          const cells: KeyCell[] = [
            {
              icon: "alert-circle",
              label: t.errors7d,
              value: number(summary.error),
              meta: summary.error > 0 ? t.last7Days : t.none,
              tone: summary.error > 0 ? "bad" : undefined,
            },
            {
              icon: "clock",
              label: t.pending7d,
              value: number(summary.pending),
              meta: summary.pending > 0 ? t.last7Days : t.none,
              tone: summary.pending > 0 ? "warn" : undefined,
            },
            { icon: "check", label: t.sent7d, value: number(summary.sent), meta: t.last7Days },
          ];
          return {
            state,
            total: result.total,
            cells,
            pendingSystem,
            // what the search found, beside the list: its hits, and how many of them failed or wait
            searchFacts: searchSummary
              ? [
                  t.matches({ count: number(searchSummary.total) }),
                  t.errorCountLabel({ count: number(searchSummary.error) }),
                  t.pendingCountLabel({ count: number(searchSummary.pending) }),
                ]
              : [],
            rows: result.items.map((item) => ({
              id: item.id,
              status: item.status,
              recipient: item.recipient,
              subject: item.subject,
              sentBy: item.sentByName ?? null,
              created: formatDateTime(item.createdAt, dateConfig),
              error: item.error ?? null,
            })),
            opened:
              opened && (access.isAdmin || opened.sentBy === user.id)
                ? {
                    id: opened.id,
                    status: opened.status,
                    recipient: opened.recipient,
                    subject: opened.subject,
                    content: opened.content,
                    sentBy: opened.sentByName ?? null,
                    created: formatDateTime(opened.createdAt, dateConfig),
                    error: opened.error ?? null,
                  }
                : null,
          };
        })()
      : null;

  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).deliveries}>
      <NotificationsScreen
        nav={observabilityAdminNav(c, locale, attention, "deliveries")}
        view={view}
        apps={apps.map((app) => ({ id: app.id, label: app.label }))}
        page={page}
        registry={registry}
        legacy={legacy}
        open={view === "legacy" ? params.get("notification")?.slice(0, 100) || null : null}
        opened={legacy?.opened ?? null}
      />
    </AdminLayout>
  );
});
