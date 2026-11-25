import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import ToolCatalog, { toolCatalogMessages } from "./ToolCatalog.island";
import { registryMessages } from "./tools/registry";
import { toolsQuery } from "./tools-query";

/** The Tools catalog on v2; its search lives in the address (`q`), so the server's page already shows the result. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const labels = registryMessages.resolve([locale]).t;
  const { t } = toolCatalogMessages.resolve([locale]);
  const { state } = toolsQuery(t.searchLabel).parse(new URL(c.req.url).searchParams);
  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: labels.home, href: "/" }, { title: labels.appName }]}>
      <ToolCatalog search={state.search} />
    </Layout>
  );
});
