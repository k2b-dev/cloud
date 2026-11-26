import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { ApprovalListQuerySchema } from "@k2b/cloud/contracts/approvals";
import { type AuthContext, getLocale, loadPendingApprovals } from "@k2b/cloud/server";
import { audit, notifications } from "@k2b/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import ActivityScreen, { type ActivityScreenProps } from "./ActivityScreen.island";
import { accountUserView } from "./account-view";
import { activityLabel, activityMark, activityOutcome } from "./activity-labels";
import { activityDaysOf, activityKindOf, activityQuery, activityStateFor, deliveryStatusOf } from "./activity-query";
import { accountMessages } from "./messages";
import { notificationChannelMeta, notificationErrorText, notificationStatusMeta } from "./notification-ui";

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** A delivery's state as a word with its meaning: delivered is ok, failed is bad, a held or waiting one waits. */
const deliveryTone = (status: NotificationDeliveryStatus): "ok" | "warn" | "bad" | undefined =>
  status === "delivered" ? "ok" : status === "failed" ? "bad" : status === "suppressed" ? undefined : "warn";

/**
 * `/me/activity`: the account's open approvals (the default), the deliveries of its notifications, or its sign-in
 * activity, as the address names them. Only the named kind is read.
 */
export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const { state } = activityQuery(t).parse(new URL(c.req.url).searchParams);
  const kind = activityKindOf(state);
  // An unknown or malformed app filter shows every app instead of an error page.
  const app = ApprovalListQuerySchema.shape.app.safeParse(c.req.query("app")).data;
  const page = parsePositiveInt(c.req.query("page"), 1);
  const appsById = () => new Map(getLocalizedRuntimeContext(c).apps.map((entry) => [entry.id, entry]));

  const loadContent = async (): Promise<ActivityScreenProps["content"]> => {
    if (kind === "open") return { kind, app, approvals: await loadPendingApprovals(c, app ? { app } : {}) };
    if (kind === "deliveries") {
      const status = deliveryStatusOf(state);
      // the failures of every page, not only this one's; one count when the filter already names them
      const [history, failed] = await Promise.all([
        notifications.user.history.list({ userId: user.id, page, perPage: 25, status, locale }),
        status === undefined
          ? notifications.user.history.list({ userId: user.id, page: 1, perPage: 1, status: "failed", locale }).then((list) => list.total)
          : Promise.resolve(undefined),
      ]);
      const apps = appsById();
      return {
        kind,
        problems: { failed: failed ?? (status === "failed" ? history.total : 0), denied: 0 },
        total: history.total,
        page: history.page,
        pages: history.totalPages,
        rows: history.items.map((item) => ({
          id: item.id,
          time: dates.formatDateTime(item.createdAt, { locale }),
          title: item.title,
          href: item.targetHref,
          source: `${apps.get(item.appId)?.name ?? item.appId} · ${item.label} · ${notificationChannelMeta(item.channel, locale).label}`,
          mark: {
            icon: (apps.get(item.appId)?.icon ?? "ti ti-bell").replace(/^ti ti-/, ""),
            color: apps.get(item.appId)?.appearance?.accent,
          },
          state: { label: notificationStatusMeta(item.status, locale).label, tone: deliveryTone(item.status) },
          // the reason of a failure only; where a delivery went is not news to the person
          detail:
            item.status === "failed"
              ? (notificationErrorText(item.errorCode, item.errorMessage, locale) ?? t.deliveryFailedReasonUnknown)
              : item.channel === "none"
                ? t.noDeliveryChannel
                : null,
        })),
      };
    }
    const activity = await audit.listSelfServiceActivity({
      userId: user.id,
      days: activityDaysOf(state),
      pagination: { page, perPage: 25 },
    });
    return {
      kind,
      problems: activity.outcomes,
      total: activity.total,
      page,
      pages: Math.max(1, Math.ceil(activity.total / 25)),
      rows: activity.items.map((entry) => ({
        id: String(entry.id),
        time: dates.formatDateTime(entry.createdAt, { locale }),
        title: activityLabel(entry, t),
        href: null,
        source: entry.context || t.accountContext,
        state: activityOutcome(entry, t) ?? { label: t.outcomeAllowed, tone: "ok" },
        detail: null,
        mark: activityMark(entry.action),
      })),
    };
  };
  const content = await loadContent();

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.activity }]}>
      <ActivityScreen
        user={accountUserView(user, t)}
        state={activityStateFor(t, kind, new URL(c.req.url).searchParams)}
        content={content}
      />
    </Layout>
  );
});
