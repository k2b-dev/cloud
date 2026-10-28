import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { aiSettingsRedirectHref } from "../ai/area";
import { adminMessages } from "../messages";
import CoreSettingsForm from "./_components/CoreSettingsForm.island";
import { buildEntries } from "./entries";

// The tabs not yet moved into an administration area.
const tabs = (t: ReturnType<typeof adminMessages.resolve>["t"], locale: string) =>
  [
    {
      id: "email-templates",
      title: t.emailTemplateSettings,
      description: t.emailTemplateSettingsDescription,
      icon: "ti ti-template",
      group: "mail" as const,
    },
  ] as const;

type TabId = ReturnType<typeof tabs>[number]["id"];

const isTabId = (value: string | undefined, availableTabs: ReturnType<typeof tabs>): value is TabId =>
  !!value && availableTabs.some((tab) => tab.id === value);

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = adminMessages.resolve([locale]).t;
  const availableTabs = tabs(t, locale);
  const rawTab = c.req.query("tab");
  // SMTP delivery moved to sender profiles — keep old links working.
  if (rawTab === "mail") return c.redirect("/admin/outgoing-mail", 302);
  // The AI tabs moved into the AI area; old links land on the same section with their filters.
  const aiHref = aiSettingsRedirectHref(rawTab, c.req.query());
  if (aiHref) return c.redirect(aiHref, 302);
  const tabId: TabId = isTabId(rawTab, availableTabs) ? rawTab : "email-templates";
  const tab = availableTabs.find((item) => item.id === tabId)!;
  const documentationBase = await coreSettings.get<string>("app.documentation_url");
  const entries = (await buildEntries(tab.group, locale)).filter((entry) => entry.kind === "template");

  return () => (
    <AdminLayout c={c} title={tab.title} scroll={false}>
      <div class="flex min-h-0 flex-1 flex-col" style="view-transition-name: admin-settings-content">
        {tab.group ? (
          <CoreSettingsForm
            documentationBase={documentationBase}
            documentationTopic={tab.id}
            title={tab.title}
            subtitle={tab.description}
            icon={tab.icon}
            entries={entries}
          />
        ) : null}
      </div>
    </AdminLayout>
  );
});
