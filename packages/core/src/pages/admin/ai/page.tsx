import { aiModelCatalog, readAiAdminOverview } from "@k2b/cloud/ai/admin";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { isAdminUser } from "@k2b/cloud/shared";
import { AdminLayout, getLocalizedRuntimeContext, getRuntimeContext, hasDedicatedRuntimeRoute } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import AiStateScreen from "./AiStateScreen.island";
import { parseAiAreaQuery } from "./area";
import BudgetsScreen from "./BudgetsScreen.island";
import ClassesScreen from "./ClassesScreen.island";
import { loadAiBudgets, loadAiClasses, loadAiProviders } from "./catalog-data";
import { loadAiProjects, loadAiSkills } from "./content-data";
import { loadAiPeople, loadAiUsage } from "./insight-data";
import { aiNav, aiSectionLabel } from "./nav";
import PeopleScreen from "./PeopleScreen.island";
import ProjectsScreen from "./ProjectsScreen.island";
import ProvidersScreen from "./ProvidersScreen.island";
import type { AiPageInput } from "./page-input";
import type { AiCatalogIndex } from "./presentation";
import SettingsScreen from "./SettingsScreen.island";
import SkillsScreen from "./SkillsScreen.island";
import { loadAiSettings } from "./settings-data";
import UsageScreen from "./UsageScreen.island";

/**
 * The AI area on v2: one section per address (`sec`, Model classes without one), each a screen of its own under the
 * area's entry in the admin bar. The catalog sections read the overview; every section reads it for the bar's dots.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const query = parseAiAreaQuery(c.req.query());
  const section = query.sec ?? "classes";
  const user = c.get("user");
  const runtime = getLocalizedRuntimeContext(c);
  const input: AiPageInput = {
    locale,
    query: c.req.query(),
    url: c.req.url,
    user,
    appNames: Object.fromEntries(runtime.apps.map((app) => [app.id, app.name])),
    showAiJobsLink: hasDedicatedRuntimeRoute(getRuntimeContext(c).apps, "/admin/observability/jobs", "core"),
    dates: getDateConfig(c),
  };

  let catalog: { overview: Awaited<ReturnType<typeof readAiAdminOverview>>; index: AiCatalogIndex } | null = null;
  try {
    const [overview, models, variants] = await Promise.all([readAiAdminOverview(), aiModelCatalog.models(), aiModelCatalog.variants()]);
    catalog = { overview, index: { models, variants, assignments: overview.assignments } };
  } catch (error) {
    console.error("[admin/ai] overview failed", error);
  }
  const nav = aiNav(c, locale, section, catalog?.overview);
  const title = aiSectionLabel(locale, section);
  const state = (kind: "noPermission" | "failed") => () => (
    <AdminLayout c={c} ui="v2" title={title}>
      <AiStateScreen nav={nav} section={section} kind={kind} />
    </AdminLayout>
  );
  if (!isAdminUser(user)) return state("noPermission");

  if (section === "classes" || section === "providers" || (section === "budgets" && query.rule !== "people")) {
    if (!catalog) return state("failed");
    const { overview, index } = catalog;
    if (section === "classes") {
      const data = await loadAiClasses(index, overview, query);
      return () => (
        <AdminLayout c={c} ui="v2" title={title}>
          <ClassesScreen nav={nav} data={data} appNames={input.appNames} />
        </AdminLayout>
      );
    }
    if (section === "providers") {
      const data = await loadAiProviders(index, overview, query);
      return () => (
        <AdminLayout c={c} ui="v2" title={title}>
          <ProvidersScreen nav={nav} data={data} />
        </AdminLayout>
      );
    }
    const data = await loadAiBudgets(index);
    return () => (
      <AdminLayout c={c} ui="v2" title={title}>
        <BudgetsScreen nav={nav} data={data} rule={query.rule ?? null} />
      </AdminLayout>
    );
  }
  if (section === "budgets") {
    const data = await loadAiPeople(input);
    return () => (
      <AdminLayout c={c} ui="v2" title={title}>
        <PeopleScreen nav={nav} data={data} />
      </AdminLayout>
    );
  }
  if (section === "general" || section === "jobs" || section === "tools") {
    const data = await loadAiSettings(input, section);
    return () => (
      <AdminLayout c={c} ui="v2" title={title}>
        <SettingsScreen nav={nav} data={data} />
      </AdminLayout>
    );
  }
  if (section === "skills") {
    const data = await loadAiSkills(input);
    return () => (
      <AdminLayout c={c} ui="v2" title={title}>
        <SkillsScreen nav={nav} data={data} />
      </AdminLayout>
    );
  }
  if (section === "projects") {
    const data = await loadAiProjects(input);
    return () => (
      <AdminLayout c={c} ui="v2" title={title}>
        <ProjectsScreen nav={nav} data={data} />
      </AdminLayout>
    );
  }
  const data = await loadAiUsage(input);
  if (!data) return c.text("Invalid AI usage filters", 400);
  return () => (
    <AdminLayout c={c} ui="v2" title={title}>
      <UsageScreen nav={nav} data={data} />
    </AdminLayout>
  );
});
