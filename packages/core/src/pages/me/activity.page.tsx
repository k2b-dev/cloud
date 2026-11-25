import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { ApprovalListQuerySchema } from "@k2b/cloud/contracts/approvals";
import { type AuthContext, getLocale, loadPendingApprovals } from "@k2b/cloud/server";
import { audit, notifications, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import ActivityScreen, { type ActivityScreenProps } from "./ActivityScreen.island";
import { accountUserView } from "./account-view";
import { activityLabel } from "./activity-labels";
import { activityDaysOf, activityKindOf, activityQuery, deliveryStatusOf } from "./activity-query";
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
  const appNames = () => new Map(getLocalizedRuntimeContext(c).apps.map((entry) => [entry.id, entry.name]));

  const loadContent = async (): Promise<ActivityScreenProps["content"]> => {
    if (kind === "open") return { kind, app, approvals: await loadPendingApprovals(c, app ? { app } : {}) };
    if (kind === "deliveries") {
      const history = await notifications.user.history.list({ userId: user.id, page, perPage: 25, status: deliveryStatusOf(state), locale });
      const names = appNames();
      return {
        kind,
        total: history.total,
        page: history.page,
        pages: history.totalPages,
        rows: history.items.map((item) => ({
          id: item.id,
          time: dates.formatDateTime(item.createdAt, { locale }),
          title: item.title,
          href: item.targetHref,
          source: `${names.get(item.appId) ?? item.appId} · ${item.label} · ${notificationChannelMeta(item.channel, locale).label}`,
          state: { label: notificationStatusMeta(item.status, locale).label, tone: deliveryTone(item.status) },
          detail:
            notificationErrorText(item.errorCode, item.errorMessage, locale) ??
            (item.channel === "none" ? t.noDeliveryChannel : (item.destinationLabel ?? null)),
        })),
      };
    }
    const activity = await audit.listSelfServiceActivity({ userId: user.id, days: activityDaysOf(state), pagination: { page: 1, perPage: 50 } });
    return {
      kind,
      total: activity.items.length,
      page: 1,
      pages: 1,
      rows: activity.items.map((entry) => ({
        id: String(entry.id),
        time: dates.formatDateTime(entry.createdAt, { locale }),
        title: activityLabel(entry, t),
        href: null,
        source: entry.context || t.accountContext,
        state:
          entry.outcome === "allowed"
            ? { label: t.outcomeAllowed, tone: "ok" }
            : entry.outcome === "denied"
              ? { label: t.outcomeDenied, tone: "warn" }
              : { label: t.outcomeFailed, tone: "bad" },
        detail: null,
      })),
    };
  };
  const [categoryPolicy, content] = await Promise.all([readAccountCategoryPolicy(), loadContent()]);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.activity }]}>
      <ActivityScreen user={accountUserView(user, categoryPolicy.login.label, t)} state={state} content={content} />
    </Layout>
  );
});
