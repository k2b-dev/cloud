import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { filesService } from "../service";
import { browserMessages } from "./browser-messages";
import SharesOverview from "./SharesOverview.island";

export default ssr<AuthContext>(async (c) => {
  const { t } = browserMessages.resolve([getLocale(c)]);
  const shares = await filesService.listShares(c.get("actor"));
  return () => (
    <Layout c={c} title={t.sharesTitle} fullWidth fullPage>
      <SharesOverview initial={shares} />
    </Layout>
  );
});
