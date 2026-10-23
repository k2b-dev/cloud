import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { getDisplayRuntimeContext, getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { preloadLayoutHelp, preloadLayoutHelpArticle } from "@k2b/cloud/ssr/help";
import { ssr } from "../../config";
import CoreLayoutHelp from "../CoreLayoutHelp.island";
import { corePageMessages } from "../messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = corePageMessages.resolve([locale]);
  const visibleIds = new Set(getDisplayRuntimeContext(c).apps.map((app) => app.id));
  const app = getLocalizedRuntimeContext(c).apps.find((candidate) => visibleIds.has(candidate.id) && candidate.id === c.req.param("appId"));
  const help = app?.help ? await preloadLayoutHelp(c, app.id) : undefined;
  if (!app || !help) return ssr.error(c, 404, { layout: "minimal", description: t.helpUnavailable });

  const requested = c.req.param("topic");
  const initialTopic = help.documents.some((document) => document.id === requested) ? requested : undefined;
  const initialArticle = initialTopic && app ? await preloadLayoutHelpArticle(c, app.id, initialTopic) : null;
  c.get("page").title = t.helpTitle({ appName: app.name });
  return () => (
    <Layout c={c} title={[{ title: app.name, href: app.nav?.href || app.adminHref }, { title: t.help }]}>
      <CoreLayoutHelp
        documents={help.documents}
        initialTopic={initialTopic}
        initialArticle={initialArticle ?? undefined}
        pageBase={help.pageBase}
      />
    </Layout>
  );
});
