import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, geoip, linuxIdentities } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SettingsPage } from "@k2b/ui";
import { z } from "zod";
import { ssr } from "../../../config";
import { approvalAvailability } from "../../app-approval/availability";
import { aiSettingsRedirectHref } from "../ai/area";
import { adminMessages } from "../messages";
import AccountOperations from "./_components/AccountOperations.island";
import CoreSettingsForm, { type SettingFieldDef } from "./_components/CoreSettingsForm.island";
import DocumentationLink from "./_components/DocumentationLink";
import LinuxIdentityPanel from "./_components/LinuxIdentityPanel.island";
import { buildEntries } from "./entries";

// Flat tab list. Each tab maps either to a core-settings group (`group` prop)
// or a dedicated immediate-action view such as Linux identities.
const tabs = (t: ReturnType<typeof adminMessages.resolve>["t"], locale: string) =>
  [
    {
      id: "storage",
      title: t.storageSettings,
      description: t.storageSettingsDescription,
      icon: "ti ti-database",
      group: "storage" as const,
    },
    {
      id: "user",
      title: t.userManagementSettings,
      description: t.userManagementSettingsDescription,
      icon: "ti ti-users",
      group: "user" as const,
    },
    {
      id: "freeipa",
      title: t.freeIpaSettings,
      description: t.freeIpaSettingsDescription,
      icon: "ti ti-building-fortress",
      group: "freeipa" as const,
    },
    { id: "linux", title: t.linuxAccess, description: t.linuxAccessDescription, icon: "ti ti-terminal-2", group: null },
    {
      id: "registration",
      title: t.accountRegistration,
      description: t.accountRegistrationDescription,
      icon: "ti ti-user-plus",
      group: "user" as const,
    },
    { id: "account-operations", title: t.accountOperations, description: t.accountOperationsDescription, icon: "ti ti-tool", group: null },
    {
      id: "email-templates",
      title: t.emailTemplateSettings,
      description: t.emailTemplateSettingsDescription,
      icon: "ti ti-template",
      group: "mail" as const,
    },
    {
      id: "security",
      title: t.securitySettings,
      description: t.securitySettingsDescription,
      icon: "ti ti-shield-lock",
      group: "security" as const,
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
  // Places and maps has its own page that checks the key with the provider — keep old links working.
  // The AI tabs moved into the AI area; old links land on the same section with their filters.
  const aiHref = aiSettingsRedirectHref(rawTab, c.req.query());
  if (aiHref) return c.redirect(aiHref, 302);
  const tabId: TabId = isTabId(rawTab, availableTabs) ? rawTab : "user";
  const tab = availableTabs.find((item) => item.id === tabId)!;
  const documentationBase = await coreSettings.get<string>("app.documentation_url");
  const approvalState = tab.id === "user" ? approvalAvailability(await appApproval.config(false).catch(() => null)) : undefined;
  // The block shows its own error with a retry when the status cannot be read; the page still renders.
  const signInLocations =
    tab.id === "user" ? { status: await geoip.status(c.get("user")).catch(() => null), actorId: c.get("user").id } : undefined;
  const operationsFreeIpaEnabled = tab.id === "account-operations" && (await coreSettings.get<boolean>("freeipa.enable"));

  let entries: SettingFieldDef[] = [];
  const linuxCursor = z.uuid().safeParse(c.req.query("after"));
  const linuxAfter = linuxCursor.success ? linuxCursor.data : null;
  const linuxSearch = (c.req.query("search") ?? "").trim();
  const linuxScope = c.req.query("scope") === "all" ? "all" : "ready";
  const linuxOverview =
    tab.id === "linux" ? await linuxIdentities.overview(c.get("user"), linuxAfter, { search: linuxSearch, scope: linuxScope }) : null;

  if (tab.group) {
    entries = await buildEntries(tab.group, locale);
    if (tab.id === "email-templates") entries = entries.filter((entry) => entry.kind === "template");
  }

  return () => (
    <AdminLayout c={c} title={tab.title} scroll={false}>
      <div class="flex min-h-0 flex-1 flex-col" style="view-transition-name: admin-settings-content">
        {linuxOverview ? (
          <LinuxIdentityPanel
            initial={linuxOverview}
            after={linuxAfter}
            search={linuxSearch}
            scope={linuxScope}
            documentationBase={documentationBase}
          />
        ) : null}
        {tab.id === "account-operations" ? (
          <SettingsPage
            title={tab.title}
            subtitle={tab.description}
            icon={tab.icon}
            actions={<DocumentationLink base={documentationBase} topic={tab.id} />}
          >
            <AccountOperations freeIpaEnabled={operationsFreeIpaEnabled} />
          </SettingsPage>
        ) : null}
        {tab.group ? (
          <CoreSettingsForm
            documentationBase={documentationBase}
            documentationTopic={tab.id}
            title={tab.title}
            subtitle={tab.description}
            icon={tab.icon}
            entries={entries}
            approvalState={approvalState}
            signInLocations={signInLocations}
            accountSection={tab.id === "registration" ? "registration" : tab.id === "user" ? "sign-in" : undefined}
            showTestStorageAction={tab.id === "storage"}
            showTestFreeIpaAction={tab.id === "freeipa"}
          />
        ) : null}
      </div>
    </AdminLayout>
  );
});
