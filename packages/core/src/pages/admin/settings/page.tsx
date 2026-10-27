import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, geoip, linuxIdentities } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SettingsPage } from "@k2b/ui";
import { z } from "zod";
import { ssr } from "../../../config";
import { approvalAvailability } from "../../app-approval/availability";
import { AI_SETTINGS_TAB_SECTIONS, aiAreaHref } from "../ai/area";
import { adminMessages } from "../messages";
import AccountOperations from "./_components/AccountOperations.island";
import CoreSettingsForm, { type SettingFieldDef } from "./_components/CoreSettingsForm.island";
import DocumentationLink from "./_components/DocumentationLink";
import LegalSettingsForm, { type LegalInitial } from "./_components/LegalSettingsForm.island";
import LinuxIdentityPanel from "./_components/LinuxIdentityPanel.island";
import { buildEntries } from "./entries";

// Flat tab list. Each tab maps either to a core-settings group (`group` prop)
// or a dedicated immediate-action view such as Projects or Legal.
const tabs = (t: ReturnType<typeof adminMessages.resolve>["t"], locale: string) =>
  [
    {
      id: "general",
      title: t.generalSettings,
      description: t.generalSettingsDescription,
      icon: "ti ti-settings",
      group: "app" as const,
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
      id: "pdf-rendering",
      title: t.pdfRenderingSettings,
      description: t.pdfRenderingSettingsDescription,
      icon: "ti ti-file-type-pdf",
      group: "gotenberg" as const,
    },
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
    {
      id: "cli",
      title: t.cliSettings,
      description: t.cliSettingsDescription,
      icon: "ti ti-terminal",
      group: "cli" as const,
    },
    {
      id: "legal",
      title: t.legalSettings,
      description: t.legalSettingsDescription,
      icon: "ti ti-file-certificate",
      group: null,
    },
  ] as const;

type TabId = ReturnType<typeof tabs>[number]["id"];

const isTabId = (value: string | undefined, availableTabs: ReturnType<typeof tabs>): value is TabId =>
  !!value && availableTabs.some((tab) => tab.id === value);

/** Read all 9 legal.* entries into the LegalSettingsForm initial shape. */
const buildLegalInitial = (entries: SettingFieldDef[]): LegalInitial => {
  const value = (key: keyof LegalInitial) => entries.find((entry) => entry.key === key)?.value;
  const stringValue = (key: keyof LegalInitial) => {
    const current = value(key);
    return typeof current === "string" ? current : "";
  };
  const asMode = (key: keyof LegalInitial): "local" | "external" => (stringValue(key) === "external" ? "external" : "local");
  return {
    "legal.terms.mode": asMode("legal.terms.mode"),
    "legal.terms.content": stringValue("legal.terms.content"),
    "legal.terms.url": stringValue("legal.terms.url"),
    "legal.privacy.mode": asMode("legal.privacy.mode"),
    "legal.privacy.content": stringValue("legal.privacy.content"),
    "legal.privacy.url": stringValue("legal.privacy.url"),
    "legal.imprint.mode": asMode("legal.imprint.mode"),
    "legal.imprint.content": stringValue("legal.imprint.content"),
    "legal.imprint.url": stringValue("legal.imprint.url"),
  };
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = adminMessages.resolve([locale]).t;
  const availableTabs = tabs(t, locale);
  const rawTab = c.req.query("tab");
  // SMTP delivery moved to sender profiles — keep old links working.
  if (rawTab === "mail") return c.redirect("/admin/outgoing-mail", 302);
  // Places and maps has its own page that checks the key with the provider — keep old links working.
  if (rawTab === "places") return c.redirect("/admin/places-and-maps", 302);
  // The AI tabs moved into the AI area; old links land on the same section with their filters.
  const aiSection = rawTab ? AI_SETTINGS_TAB_SECTIONS[rawTab] : undefined;
  if (aiSection) {
    const params = Object.fromEntries(Object.entries(c.req.query()).filter(([key]) => key !== "tab"));
    return c.redirect(aiAreaHref({ sec: aiSection }, params), 302);
  }
  const tabId: TabId = isTabId(rawTab, availableTabs) ? rawTab : "general";
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
  let legalInitial: LegalInitial | null = null;

  if (tab.group) {
    entries = await buildEntries(tab.group, locale);
    if (tab.id === "email-templates") entries = entries.filter((entry) => entry.kind === "template");
  } else if (tab.id === "legal") {
    entries = await buildEntries("legal", locale);
    legalInitial = buildLegalInitial(entries);
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
            showTestPdfAction={tab.id === "pdf-rendering"}
            showTestFreeIpaAction={tab.id === "freeipa"}
            showLegacySettings={tab.id === "general"}
          />
        ) : null}

        {tab.id === "legal" && legalInitial ? (
          <LegalSettingsForm title={tab.title} subtitle={tab.description} icon={tab.icon} initial={legalInitial} entries={entries} />
        ) : null}
      </div>
    </AdminLayout>
  );
});
