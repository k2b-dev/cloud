import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import { chatRequestContext } from "../request-context";
import { chatService } from "../service";
import { providerFor, typePresentation } from "../service/discussion-read";
import ChatAdmin, { type ChatAdminView } from "./ChatAdmin.island";
import { chatV2Messages } from "./v2/chat-v2-messages";

/** `/admin/chat`: operational state. Later slices add their rows to the same health snapshot. */
export default ssr<AuthContext>(async (c) => {
  const { t } = chatMessages.resolve([getLocale(c)]);
  const { t: v2 } = chatV2Messages.resolve([getLocale(c)]);
  const health = await chatService.health();
  const check = health.systemNotifications;
  const reasons = new Map([
    ["no_readable", t.readerNoReadable],
    ["no_credential", t.readerNoCredential],
    ["no_internal_origin", t.readerNoOrigin],
    ["no_app_identity", t.readerNoIdentity],
    ["not_admitted", t.readerNotAdmitted],
    ["check_unavailable", t.readerUnavailable],
    ["health_unavailable", t.readerHealthUnavailable],
    ["health_capacity", t.readerHealthCapacity],
    ["decision_expired", t.readerDecisionExpired],
    ["rate_limited", t.readerRateLimited],
    ["lock_timeout", t.readerLockTimeout],
    ["handoff_failed", t.readerUnavailable],
  ]);
  const reason = reasons.get(check.reason ?? "");
  const checkDetail = [
    reason ?? (check.status === "unchecked" ? t.systemNotificationsSetup : null),
    check.resourceType,
    check.checkedAt ? t.observed({ time: dates.formatTime(check.checkedAt, getDateConfig(c)) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const ok = health.status === "ok";
  const time = dates.formatTime(health.observedAt, getDateConfig(c));
  const notifications = health.systemNotifications.status;
  // A place is named by its type's title ("Space"), as Chat's discussions name it; the raw type when it is unknown.
  const failing = check.providers.filter((provider) => provider.status !== "ok");
  const typeTitles = await Promise.all(
    failing.map(async (provider) => {
      const found = await providerFor(chatRequestContext(c), provider.resourceType).catch(() => undefined);
      return found ? typePresentation(found, provider.resourceType).typeTitle : provider.resourceType;
    }),
  );
  const view: ChatAdminView = {
    nav: adminNavigation(c),
    title: t.appName,
    state: ok ? t.healthy : t.unavailable,
    observed: t.observed({ time }),
    labels: { database: t.database, notifications: t.systemNotifications, providers: v2.adminProviders, logs: t.logs },
    database: {
      ready: health.database.status === "ok",
      value: health.database.status === "ok" ? t.databaseReady : t.databaseUnavailable,
      latency: health.database.latencyMs === null ? undefined : t.latency({ value: health.database.latencyMs }),
    },
    notifications: {
      status: notifications === "ok" || notifications === "unchecked" || notifications === "failing" ? notifications : "not_configured",
      value:
        notifications === "ok"
          ? t.systemNotificationsOk
          : notifications === "unchecked"
            ? t.systemNotificationsUnchecked
            : notifications === "failing"
              ? t.systemNotificationsFailing
              : t.systemNotificationsNotConfigured,
      detail:
        check.reason === "health_capacity" || check.reason === "health_unavailable" || !check.providers.length
          ? checkDetail || undefined
          : undefined,
    },
    providers: failing.map((provider, index) => ({
      type: typeTitles[index] ?? provider.resourceType,
      line: [reasons.get(provider.reason ?? ""), t.observed({ time: dates.formatTime(provider.checkedAt, getDateConfig(c)) })]
        .filter(Boolean)
        .join(" · "),
    })),
  };

  return () => (
    <AdminLayout c={c} ui="v2" title={t.appName}>
      <ChatAdmin view={view} />
    </AdminLayout>
  );
});
