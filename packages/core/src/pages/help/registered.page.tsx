import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { resolveHelpManifest } from "@valentinkolb/cloud/shared";
import { getLocalizedRuntimeContext } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import CoreLayoutHelp from "../CoreLayoutHelp.island";
import { corePageMessages } from "../messages";

export default ssr<AuthContext>((c) => {
  const locale = getLocale(c);
  const { t } = corePageMessages.resolve([locale]);
  const app = getLocalizedRuntimeContext(c).apps.find((candidate) => candidate.id === c.req.param("appId"));
  const help = app?.help ? resolveHelpManifest(app.help, locale) : undefined;
  if (!app || !help) {
    c.status(404);
    return () => <main class="p-8 text-sm text-dimmed">{t.helpUnavailable}</main>;
  }

  const requested = c.req.param("topic");
  const initialTopic = help.documents.some((document) => document.id === requested) ? requested : undefined;
  c.get("page").title = t.helpTitle({ appName: app.name });
  return () => <CoreLayoutHelp documents={help.documents} initialTopic={initialTopic} pageBase={help.pageBase} />;
});
