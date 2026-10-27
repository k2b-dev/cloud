import { aiAppSkills, aiConversations, aiProjects, aiSkills } from "@k2b/cloud/ai";
import {
  AI_BACKGROUND_TASK_PROMPTS,
  type AiAdminOverview,
  aiModelCatalog,
  aiModelUsage,
  aiUsage,
  quotaAdminConfig,
  quotaReport,
  readAiAdminOverview,
} from "@k2b/cloud/ai/admin";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { type AiModel, type AiModelVariant, AiUsageQuerySchema } from "@k2b/cloud/shared";
import { AdminLayout, getLocalizedRuntimeContext, getRuntimeContext, hasDedicatedRuntimeRoute } from "@k2b/cloud/ssr";
import { Placeholder } from "@k2b/ui";
import type { JSX } from "solid-js";
import { ssr } from "../../../config";
import AiProjectsAdminPanel from "../settings/_components/AiProjectsAdminPanel";
import AiQuotaAdmin from "../settings/_components/AiQuotaAdmin.island";
import AiSkillsAdminPanel from "../settings/_components/AiSkillsAdminPanel";
import AiUsageAdminPanel from "../settings/_components/AiUsageAdminPanel";
import CoreSettingsForm from "../settings/_components/CoreSettingsForm.island";
import { buildEntries } from "../settings/entries";
import { isWideSection, parseAiAreaQuery } from "./area";
import { aiAreaMessages } from "./messages";
import type { AiCatalogIndex } from "./presentation";
import { AiAreaView } from "./view";

type Overview = AiAdminOverview;

const sectionIcon = { general: "ti ti-adjustments", jobs: "ti ti-activity", tools: "ti ti-plug" } as const;

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = aiAreaMessages.resolve([locale]).t;
  const query = parseAiAreaQuery(c.req.query());
  const runtime = getLocalizedRuntimeContext(c);

  const studioLinks = runtime.apps.flatMap((app) =>
    (app.adminNav ?? [])
      .filter((group) => group.section === "ai")
      .flatMap((group) =>
        group.links
          .filter((link) => link.href.startsWith("/admin/"))
          .map((link) => ({ href: link.href, label: link.label, icon: link.icon.replace(/^ti\s+/, ""), app: t.fromApp({ p: app.name }) })),
      ),
  );

  let overview: Overview | null = null;
  let index: AiCatalogIndex | null = null;
  let loadFailed = false;
  try {
    const [loaded, models, variants] = await Promise.all([readAiAdminOverview(), aiModelCatalog.models(), aiModelCatalog.variants()]);
    overview = loaded;
    index = { models, variants, assignments: loaded.assignments };
  } catch (error) {
    console.error("[admin/ai] overview failed", error);
    loadFailed = true;
  }

  const provider = query.p ? overview?.providers.find((candidate) => candidate.id === query.p) : undefined;
  const providerDetail = provider ? await aiModelCatalog.providerDetail(provider.id).catch(() => null) : null;
  const model: (AiModel & { variants: AiModelVariant[] }) | null =
    query.m && provider ? await aiModelCatalog.modelDetail(query.m).catch(() => null) : null;
  const [usage, quotaConfig] = model
    ? await Promise.all([
        aiModelUsage(
          model.variants.map((variant) => variant.id),
          [model.id],
        ).catch(() => null),
        quotaAdminConfig().catch(() => null),
      ])
    : [null, null];
  const assignmentDetails = query.sec === "classes" && query.slot ? await aiModelCatalog.assignmentsForAdmin().catch(() => null) : null;

  // Wide sections keep their content and loaders from the former settings tabs.
  const section = query.sec;
  const settingsEntries = section === "general" || section === "jobs" || section === "tools" ? await buildEntries("ai", locale) : [];
  const enrichment = section === "jobs" ? await aiConversations.getEnrichmentOverview() : null;
  const showAiJobsLink = hasDedicatedRuntimeRoute(getRuntimeContext(c).apps, "/admin/observability/jobs", "core");
  const documentationBase = await coreSettings.get<string>("app.documentation_url");
  const search = (c.req.query("search") ?? "").trim();
  const requestedPage = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) ? requestedPage : 1;
  const skillsData =
    section === "skills"
      ? await Promise.all([
          aiSkills.admin.list({ search: search || undefined, page, perPage: 100 }),
          aiSkills.admin.summary({ search: search || undefined }),
          aiAppSkills.appSkillIssues(),
        ])
      : null;
  const projectsData =
    section === "projects"
      ? await Promise.all([
          aiProjects.admin.list({ search: search || undefined, page, perPage: 100 }),
          aiProjects.admin.summary({ search: search || undefined }),
        ])
      : null;
  const usageQuery = section === "usage" ? AiUsageQuerySchema.safeParse(c.req.query()) : null;
  if (usageQuery && !usageQuery.success) return c.text("Invalid AI usage filters", 400);
  const usageReport = usageQuery?.success ? await aiUsage.report(usageQuery.data.range, usageQuery.data) : null;
  const budgets =
    section === "budgets" && index
      ? {
          config: await quotaAdminConfig(),
          report: await quotaReport(c.req.query()),
          models: index.models.map((m) => ({
            id: m.id,
            label: m.label,
            pricing: m.pricing ?? undefined,
            enabled: m.enabled,
            capabilities: m.kind === "transcription" ? ["transcription"] : [...m.capabilities],
          })),
        }
      : null;

  const sectionTitle = section
    ? {
        classes: t.recs,
        providers: provider?.label ?? t.g_models,
        general: t.general,
        budgets: t.budgets,
        jobs: t.jobs,
        tools: t.tools,
        skills: t.skills,
        projects: t.projects,
        usage: t.usage,
      }[section]
    : t.aiArea;

  const failure = (
    <Placeholder
      state="error"
      icon="ti ti-alert-triangle"
      title={t.loadFailTitle}
      description={t.loadFailSub}
      action={
        <a class="k2b-button" data-variant="secondary" href={c.req.url}>
          <i class="ti ti-refresh" aria-hidden="true" />
          {t.retry}
        </a>
      }
    />
  );

  const wideContent = (): JSX.Element => {
    if (section === "general" || section === "jobs" || section === "tools")
      return (
        <CoreSettingsForm
          documentationBase={documentationBase}
          documentationTopic={`ai-${section}`}
          title={sectionTitle}
          subtitle=""
          icon={sectionIcon[section]}
          entries={settingsEntries}
          aiEnrichmentOverview={enrichment}
          backgroundTaskPrompts={section === "jobs" ? AI_BACKGROUND_TASK_PROMPTS : undefined}
          aiSection={section}
          showAiJobsLink={showAiJobsLink}
          embedded
        />
      );
    if (section === "skills" && skillsData)
      return (
        <AiSkillsAdminPanel
          skills={skillsData[0].items}
          summary={skillsData[1]}
          appSkillIssues={skillsData[2]}
          appNames={Object.fromEntries(runtime.apps.map((app) => [app.id, app.name]))}
          total={skillsData[0].total}
          page={skillsData[0].page}
          perPage={skillsData[0].perPage}
          search={search}
        />
      );
    if (section === "projects" && projectsData)
      return (
        <AiProjectsAdminPanel
          projects={projectsData[0].items}
          summary={projectsData[1]}
          total={projectsData[0].total}
          page={projectsData[0].page}
          perPage={projectsData[0].perPage}
          search={search}
        />
      );
    if (section === "usage" && usageReport) return <AiUsageAdminPanel report={usageReport} />;
    if (section === "budgets" && budgets) return <AiQuotaAdmin config={budgets.config} models={budgets.models} report={budgets.report} />;
    return failure;
  };

  return () => (
    <AdminLayout c={c} title={t.aiArea} ownMain>
      <AiAreaView
        t={t}
        locale={locale}
        query={query}
        overview={overview}
        index={index}
        loadFailed={loadFailed}
        studioLinks={studioLinks}
        provider={provider}
        providerDetail={providerDetail}
        model={model}
        usage={usage}
        accountingUnit={quotaConfig?.unit ?? null}
        assignmentDetails={assignmentDetails}
        appNames={Object.fromEntries(runtime.apps.map((app) => [app.id, app.name]))}
        retryHref={c.req.url}
        wide={isWideSection(section) ? wideContent() : undefined}
      />
    </AdminLayout>
  );
});
