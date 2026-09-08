import {
  type AiEnrichmentOverview,
  type AiProjectAdminListItem,
  type AiProjectAdminSummary,
  type AiSkillAdminListItem,
  type AiSkillAdminSummary,
  aiConversations,
  aiProjects,
  aiSkills,
  listAiCredentialProfileIds,
} from "@valentinkolb/cloud/ai";
import {
  AI_BACKGROUND_TASK_PROMPTS,
  aiModelAccess,
  type AiModelAccessMap,
  type AiUsageReport,
  aiUsage,
} from "@valentinkolb/cloud/ai/admin";
import { AiUsageQuerySchema } from "@valentinkolb/cloud/shared";
import { getLocale, type AuthContext } from "@valentinkolb/cloud/server";
import { settingsService, linuxIdentities } from "@valentinkolb/cloud/services";
import { AdminLayout, getRuntimeContext, hasDedicatedRuntimeRoute } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../config";
import AiProjectsAdminPanel from "./_components/AiProjectsAdminPanel";
import AiSkillsAdminPanel from "./_components/AiSkillsAdminPanel";
import AiUsageAdminPanel from "./_components/AiUsageAdminPanel";
import CoreSettingsForm, { type SettingFieldDef } from "./_components/CoreSettingsForm.island";
import LegalSettingsForm, { type LegalInitial } from "./_components/LegalSettingsForm.island";
import { adminMessages } from "../messages";
import LinuxIdentityPanel from "./_components/LinuxIdentityPanel.island";
import { z } from "zod";

// Flat tab list. Each tab maps either to a core-settings group (`group` prop)
// or a dedicated immediate-action view such as Projects or Legal.
const tabs = (t: ReturnType<typeof adminMessages.resolve>["t"]) =>
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
      id: "ai-general",
      title: t.aiGeneral,
      description: t.aiGeneralDescription,
      icon: "ti ti-adjustments",
      group: "ai" as const,
    },
    {
      id: "ai-providers",
      title: t.aiProviders,
      description: t.aiProvidersDescription,
      icon: "ti ti-sparkles",
      group: "ai" as const,
    },
    {
      id: "ai-usage",
      title: t.aiUsage,
      description: t.aiUsageDescription,
      icon: "ti ti-chart-histogram",
      group: null,
    },
    {
      id: "ai-jobs",
      title: t.aiBackgroundJobs,
      description: t.aiBackgroundJobsDescription,
      icon: "ti ti-activity",
      group: "ai" as const,
    },
    {
      id: "ai-skills",
      title: t.aiSkills,
      description: t.aiSkillsDescription,
      icon: "ti ti-wand",
      group: null,
    },
    {
      id: "ai-projects",
      title: t.aiProjects,
      description: t.aiProjectsDescription,
      icon: "ti ti-folders",
      group: null,
    },
    { id: "mail", title: t.mailSettings, description: t.mailSettingsDescription, icon: "ti ti-mail", group: "mail" as const },
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

/**
 * Pull the SettingFieldDef list for a given group from the global settings
 * registry. Returns entries with current values resolved (DB → env → default).
 */
const buildEntries = async (group: string, locale: string): Promise<SettingFieldDef[]> => {
  const result = await settingsService.entry.list({ filter: { group }, locale });
  return result.items.map((item) => ({
    key: item.key,
    label: item.label,
    description: item.description,
    kind: item.kind as SettingFieldDef["kind"],
    value: item.value,
    default: item.default,
    resetValue: item.resetValue,
    valueSource: item.valueSource,
    resetValueSource: item.resetValueSource,
    isCustom: item.isCustom,
    group: item.group,
    options: item.options,
    min: item.min,
    max: item.max,
    placeholder: item.placeholder,
    templateVars: item.templateVars,
  }));
};

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
  const availableTabs = tabs(t);
  const rawTab = c.req.query("tab");
  // "ai" predates the split into the AI sidebar group — keep old links working.
  const legacyTab = rawTab === "ai" ? "ai-general" : rawTab;
  const tabId: TabId = isTabId(legacyTab, availableTabs) ? legacyTab : "general";
  const tab = availableTabs.find((item) => item.id === tabId)!;
  const showAiJobsLink = hasDedicatedRuntimeRoute(getRuntimeContext(c).apps, "/admin/observability/jobs", "core");

  const aiSection =
    tab.id === "ai-general" ? "general" : tab.id === "ai-providers" ? "providers" : tab.id === "ai-jobs" ? "jobs" : undefined;

  let entries: SettingFieldDef[] = [];
  const linuxCursor = z.uuid().safeParse(c.req.query("after"));
  const linuxAfter = linuxCursor.success ? linuxCursor.data : null;
  const linuxSearch = (c.req.query("search") ?? "").trim();
  const linuxScope = c.req.query("scope") === "all" ? "all" : "ready";
  const linuxOverview = tab.id === "linux" ? await linuxIdentities.overview(c.get("user"), linuxAfter, { search: linuxSearch, scope: linuxScope }) : null;
  let legalInitial: LegalInitial | null = null;
  let aiEnrichmentOverview: AiEnrichmentOverview | null = null;
  // Which profiles have a stored provider key. The keys themselves never leave
  // the server, so the form shows presence instead of a value.
  let aiCredentialProfileIds: string[] = [];
  let modelAccess: AiModelAccessMap = {};
  let aiProjectItems: AiProjectAdminListItem[] = [];
  let aiProjectSummary: AiProjectAdminSummary | null = null;
  let aiProjectTotal = 0;
  let aiProjectPage = 1;
  let aiProjectPerPage = 100;
  let aiSkillItems: AiSkillAdminListItem[] = [];
  let aiSkillSummary: AiSkillAdminSummary | null = null;
  let aiSkillTotal = 0;
  let aiSkillPage = 1;
  let aiSkillPerPage = 100;
  let aiUsageReport: AiUsageReport | null = null;
  const search = (c.req.query("search") ?? "").trim();
  const requestedPage = Number.parseInt(c.req.query("page") ?? "1", 10);

  if (tab.group) {
    entries = await buildEntries(tab.group, locale);
    if (tab.id === "mail") entries = entries.filter((entry) => entry.kind !== "template");
    if (tab.id === "email-templates") entries = entries.filter((entry) => entry.kind === "template");
    if (tab.id === "ai-jobs") aiEnrichmentOverview = await aiConversations.getEnrichmentOverview();
    if (tab.id === "ai-providers") {
      [aiCredentialProfileIds, modelAccess] = await Promise.all([listAiCredentialProfileIds(), aiModelAccess.listForAdmin()]);
    }
  } else if (tab.id === "legal") {
    entries = await buildEntries("legal", locale);
    legalInitial = buildLegalInitial(entries);
  } else if (tab.id === "ai-skills") {
    const [skills, summary] = await Promise.all([
      aiSkills.admin.list({ search: search || undefined, page: Number.isFinite(requestedPage) ? requestedPage : 1, perPage: 100 }),
      aiSkills.admin.summary({ search: search || undefined }),
    ]);
    aiSkillItems = skills.items;
    aiSkillSummary = summary;
    aiSkillTotal = skills.total;
    aiSkillPage = skills.page;
    aiSkillPerPage = skills.perPage;
  } else if (tab.id === "ai-usage") {
    const parsed = AiUsageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.text("Invalid AI usage filters", 400);
    aiUsageReport = await aiUsage.report(parsed.data.range, parsed.data);
  } else if (tab.id === "ai-projects") {
    const [projects, summary] = await Promise.all([
      aiProjects.admin.list({ search: search || undefined, page: Number.isFinite(requestedPage) ? requestedPage : 1, perPage: 100 }),
      aiProjects.admin.summary({ search: search || undefined }),
    ]);
    aiProjectItems = projects.items;
    aiProjectSummary = summary;
    aiProjectTotal = projects.total;
    aiProjectPage = projects.page;
    aiProjectPerPage = projects.perPage;
  }

  return () => (
    <AdminLayout c={c} title={tab.title}>
      <div class={tab.id === "ai-usage" ? "flex min-w-0 flex-none flex-col" : "flex min-h-0 flex-1 flex-col"} style="view-transition-name: admin-settings-content">
        {linuxOverview ? <LinuxIdentityPanel initial={linuxOverview} after={linuxAfter} search={linuxSearch} scope={linuxScope} /> : null}
        {tab.group ? (
          <CoreSettingsForm
            title={tab.title}
            subtitle={tab.description}
            icon={tab.icon}
            entries={entries}
            showTestEmailAction={tab.id === "mail"}
            showTestPdfAction={tab.id === "pdf-rendering"}
            showTestFreeIpaAction={tab.id === "freeipa"}
            showLegacySettings={tab.id === "general"}
            aiEnrichmentOverview={aiEnrichmentOverview}
            backgroundTaskPrompts={tab.id === "ai-jobs" ? AI_BACKGROUND_TASK_PROMPTS : undefined}
            aiCredentialProfileIds={aiCredentialProfileIds}
            aiModelAccess={modelAccess}
            aiSection={aiSection}
            showAiJobsLink={showAiJobsLink}
          />
        ) : null}

        {tab.id === "legal" && legalInitial ? (
          <LegalSettingsForm title={tab.title} subtitle={tab.description} icon={tab.icon} initial={legalInitial} entries={entries} />
        ) : null}

        {tab.id === "ai-projects" && aiProjectSummary ? (
          <AiProjectsAdminPanel
            projects={aiProjectItems}
            summary={aiProjectSummary}
            total={aiProjectTotal}
            page={aiProjectPage}
            perPage={aiProjectPerPage}
            search={search}
          />
        ) : null}

        {tab.id === "ai-skills" && aiSkillSummary ? (
          <AiSkillsAdminPanel
            skills={aiSkillItems}
            summary={aiSkillSummary}
            total={aiSkillTotal}
            page={aiSkillPage}
            perPage={aiSkillPerPage}
            search={search}
          />
        ) : null}

        {tab.id === "ai-usage" && aiUsageReport ? <AiUsageAdminPanel report={aiUsageReport} /> : null}
      </div>
    </AdminLayout>
  );
});
