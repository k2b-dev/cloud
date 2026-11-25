import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { audit, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import ActivityScreen from "./ActivityScreen.island";
import { accountUserView } from "./account-view";
import { activityLabel } from "./activity-labels";
import { activityDaysOf, activityQuery } from "./activity-query";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";

/** `/me/security/activity`: the account's own activity in the range the address names (7, 30 or 90 days). */
export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const { state } = activityQuery(t).parse(new URL(c.req.url).searchParams);
  const [categoryPolicy, activityPage] = await Promise.all([
    readAccountCategoryPolicy(),
    audit.listSelfServiceActivity({ userId: user.id, days: activityDaysOf(state), pagination: { page: 1, perPage: 50 } }),
  ]);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.account, href: "/me" },
        { title: t.security, href: "/me/security" },
        { title: t.accountActivity },
      ]}
    >
      <ActivityScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        appTab={pwaAvailable(c)}
        state={state}
        rows={activityPage.items.map((entry) => ({
          id: String(entry.id),
          time: dates.formatDateTime(entry.createdAt, { locale }),
          label: activityLabel(entry, t),
          outcome: entry.outcome,
          context: entry.context || null,
        }))}
      />
    </Layout>
  );
});
