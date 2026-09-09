import { NotFoundState } from "@k2b/ui";
import { Layout } from "@k2b/cloud/ssr";
import { getLocale } from "@k2b/cloud/server";
import { ssr } from "../config";
import { corePageMessages } from "./messages";

/** 404 Not Found page. */
export default ssr((c) => {
  const t = corePageMessages.resolve([getLocale(c)]).t;
  c.status(404);
  return () => (
    <Layout c={c} title={t.pageNotFound}>
      <NotFoundState code="404" title={t.nothingHere} description={t.wrongTurn} action={{ label: t.goHome, href: "/" }} />
    </Layout>
  );
});
