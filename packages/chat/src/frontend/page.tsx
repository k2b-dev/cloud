import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { chatMessages } from "../messages";
import ChatWorkspace from "./ChatWorkspace";

export default ssr<AuthContext>(async (c) => {
  const { t } = chatMessages.resolve([getLocale(c)]);
  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <ChatWorkspace />
    </Layout>
  );
});
