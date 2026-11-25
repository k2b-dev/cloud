import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { pulseMessages } from "../../messages";
import { QUERIES_PER_PAGE } from "../screens/QueriesScreen";
import QueriesScreen from "../screens/QueriesScreen.island";
import { loadPulseQueriesPageData } from "./page-data";

/** The saved queries of a base, rendered on the server with their first page. */
export default ssr<AuthContext>(async (c) => {
  const data = await loadPulseQueriesPageData(c, QUERIES_PER_PAGE);
  const { t } = pulseMessages.resolve([getLocale(c)]);
  if (data.kind === "error") return ssr.error(c, data.status, { action: { label: t.backToPulse, href: "/app/pulse" } });
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.appName, href: "/app/pulse" },
        { title: data.base.name, href: `/app/pulse/${data.publicBaseId}` },
      ]}
    >
      <QueriesScreen
        bases={data.bases}
        baseId={data.publicBaseId}
        sourceCount={data.sourceCount}
        page={data.page}
        offset={data.offset}
        dateConfig={{ timeZone: data.dateConfig.timeZone ?? "UTC", locale: data.dateConfig.locale ?? "en" }}
      />
    </Layout>
  );
});
