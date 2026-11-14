import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { i18n } from "@k2b/stdlib";
import { AppOverview } from "@k2b/ui";
import { ssr } from "../config";
import ToolCatalog from "./ToolCatalog.island";
import { ToolsWorkspace } from "./ToolsWorkspace";
import { registryMessages } from "./tools/registry";

export const toolsPageMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      subtitle: "Focused utilities for common data, media, security, and network tasks.",
      findTitle: "Find a utility",
      findDescription: "Describe the task or browse the complete collection.",
    },
    de: {
      subtitle: "Werkzeuge für alltägliche Aufgaben mit Daten, Medien, Sicherheit und Netzwerk.",
      findTitle: "Passendes Werkzeug finden",
      findDescription: "Beschreibe deine Aufgabe oder durchsuche alle Werkzeuge.",
    },
  },
});

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = toolsPageMessages.resolve([locale]);
  const labels = registryMessages.resolve([locale]).t;
  const initialQuery = c.req.query("q") ?? "";
  return () => (
    <Layout c={c} fullPage workspaceSidebarCollapsible title={[{ title: labels.home, href: "/" }, { title: labels.appName }]}>
      <ToolsWorkspace>
        <AppOverview title={labels.appName} subtitle={t.subtitle} icon="ti ti-tools">
          <AppOverview.Main title={t.findTitle} description={t.findDescription}>
            <ToolCatalog initialQuery={initialQuery} />
          </AppOverview.Main>
        </AppOverview>
      </ToolsWorkspace>
    </Layout>
  );
});
