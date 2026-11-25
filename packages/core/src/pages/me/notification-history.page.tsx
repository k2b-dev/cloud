import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { notifications, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import { accountUserView } from "./account-view";
import { pwaAvailable } from "./app-availability";
import HistoryScreen from "./HistoryScreen.island";
import { historyQuery, historyStatusOf } from "./history-query";
import { accountMessages } from "./messages";
import { notificationChannelMeta, notificationErrorText, notificationStatusMeta } from "./notification-ui";

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** A delivery's state as a word with its meaning: delivered is ok, failed is bad, a held or waiting one waits. */
const statusTone = (status: NotificationDeliveryStatus): "ok" | "warn" | "bad" | undefined =>
  status === "delivered" ? "ok" : status === "failed" ? "bad" : status === "suppressed" ? undefined : "warn";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const { state } = historyQuery(t).parse(new URL(c.req.url).searchParams);
  const page = parsePositiveInt(c.req.query("page"), 1);
  const history = await notifications.user.history.list({ userId: user.id, page, perPage: 25, status: historyStatusOf(state), locale });
  const appNames = new Map(getLocalizedRuntimeContext(c).apps.map((app) => [app.id, app.name]));

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.account, href: "/me" },
        { title: t.notifications, href: "/me/notifications" },
        { title: t.deliveryHistory },
      ]}
    >
      <HistoryScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        appTab={pwaAvailable(c)}
        state={state}
        total={history.total}
        page={history.page}
        pages={history.totalPages}
        rows={history.items.map((item) => ({
          id: item.id,
          time: dates.formatDateTime(item.createdAt, { locale }),
          title: item.title,
          href: item.targetHref,
          source: `${appNames.get(item.appId) ?? item.appId} · ${item.label}`,
          channel: notificationChannelMeta(item.channel, locale).label,
          destination: item.channel === "none" ? t.noDeliveryChannel : (item.destinationLabel ?? ""),
          status: { label: notificationStatusMeta(item.status, locale).label, tone: statusTone(item.status) },
          error: notificationErrorText(item.errorCode, item.errorMessage, locale),
        }))}
      />
    </Layout>
  );
});
