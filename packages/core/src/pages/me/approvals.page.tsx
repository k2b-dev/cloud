import { ApprovalListQuerySchema } from "@k2b/cloud/contracts/approvals";
import { type AuthContext, getLocale, loadPendingApprovals } from "@k2b/cloud/server";
import { readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import ApprovalsScreen from "./ApprovalsScreen.island";
import { accountUserView } from "./account-view";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const { t } = accountMessages.resolve([getLocale(c)]);
  // An unknown or malformed app filter shows every app instead of an error page.
  const app = ApprovalListQuerySchema.shape.app.safeParse(c.req.query("app")).data;
  const [categoryPolicy, page] = await Promise.all([readAccountCategoryPolicy(), loadPendingApprovals(c, app ? { app } : {})]);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.approvals }]}>
      <ApprovalsScreen user={accountUserView(user, categoryPolicy.login.label, t)} appTab={pwaAvailable(c)} app={app} initial={page} />
    </Layout>
  );
});
