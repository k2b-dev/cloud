import { ApprovalListQuerySchema } from "@k2b/cloud/contracts/approvals";
import { type AuthContext, getLocale, loadPendingApprovals } from "@k2b/cloud/server";
import { readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AccountApprovals from "./AccountApprovals.island";
import AccountHub, { AccountPage } from "./AccountHub";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const { t } = accountMessages.resolve([getLocale(c)]);
  // An unknown or malformed app filter shows every app instead of an error page.
  const app = ApprovalListQuerySchema.shape.app.safeParse(c.req.query("app")).data;
  const [categoryPolicy, page] = await Promise.all([readAccountCategoryPolicy(), loadPendingApprovals(c, app ? { app } : {})]);

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.approvals }]}>
      <AccountHub appTab={pwaAvailable(c)} user={user} active="approvals" loginLabel={categoryPolicy.login.label}>
        <AccountPage title={t.approvals} description={t.approvalsDescription}>
          <AccountApprovals app={app} initial={page} />
        </AccountPage>
      </AccountHub>
    </Layout>
  );
});
