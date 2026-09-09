import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { resolveHelpManifest } from "@k2b/cloud/shared";
import { getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import CoreLayoutHelp from "../CoreLayoutHelp.island";
import { corePageMessages } from "../messages";

export default ssr<AuthContext>((c) => {
  const locale = getLocale(c);
  const { t } = corePageMessages.resolve([locale]);
  const app = getLocalizedRuntimeContext(c).apps.find((candidate) => candidate.id === c.req.param("appId"));
  const help = app?.help ? resolveHelpManifest(app.help, locale) : undefined;
  if (!app || !help) return ssr.error(c, 404, { layout: "minimal", description: t.helpUnavailable });

  const requested = c.req.param("topic");
  const initialTopic = help.documents.some((document) => document.id === requested) ? requested : undefined;
  c.get("page").title = t.helpTitle({ appName: app.name });
  return () => <CoreLayoutHelp documents={help.documents} initialTopic={initialTopic} pageBase={help.pageBase} />;
});
