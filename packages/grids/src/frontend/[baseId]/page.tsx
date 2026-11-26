import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { NotFoundState } from "@k2b/ui";
import { currentActorUser } from "../../api/permissions";
import { withInitialGqlResults } from "../../api/workspace-query-preview";
import { ssr } from "../../config";
import BaseHome from "../_components/frame/BaseHome.island";
import { homeTab, resourcesQuery } from "../_components/frame/resources-query";
import RecordsScreen from "../_components/records-view/RecordsScreen.island";
import { parseDocumentViewMode, parseNavigationExpansion } from "../_components/sidebar/GridsSettingsStore";
import RememberGridsPath from "../_components/sidebar/RememberGridsPath.island";
import GridsWorkspace from "../_components/workspace/GridsWorkspace";
import { projectPublicWorkspaceState } from "../_components/workspace/workspace-public-state";
import { loadGridsWorkspaceState } from "../_components/workspace/workspace-state";
import { serializeWorkspaceState } from "../_components/workspace/workspace-state-serialization";
import { resolveGridsMessages } from "../messages";
import { gridsPageScope } from "../page-context";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const user = currentActorUser(c);
  if (!user) {
    return () => (
      <Layout c={c} title={[{ title: "Grids", href: "/app/grids" }]}>
        <div class="paper p-8 max-w-md mx-auto mt-16 text-center text-dimmed">
          <i class="ti ti-lock text-sm" /> {t.signInToOpenGrids}
        </div>
      </Layout>
    );
  }
  const baseShortId = c.req.param("baseId")!;
  const loaded = await serializeWorkspaceState(
    baseShortId,
    async () => {
      const loadedState = await loadGridsWorkspaceState({
        user,
        baseShortId,
        href: c.req.url,
        activeTableSlug: c.req.param("tableId") ?? null,
        activeViewSlug: c.req.param("viewId") ?? null,
        activeWorkflowSlug: c.req.param("workflowId") ?? null,
        activeDocumentTableSlug: c.req.param("documentTableId") ?? null,
        activeDocumentTemplateSlug: c.req.param("documentTemplateId") ?? null,
        documentsRequested: c.req.path.endsWith("/documents"),
        activeCustomAppSlug: c.req.param("customAppId") ?? null,
        initialDocumentViewMode: parseDocumentViewMode(c.req.header("Cookie")),
        dateConfig: await getDateConfig(c),
        locale,
      });
      return {
        loadedState,
        state: loadedState.kind === "ok" ? await projectPublicWorkspaceState(await withInitialGqlResults(c, loadedState), locale) : null,
      };
    },
    c.req.raw.signal,
  );
  const { loadedState } = loaded;

  if (loadedState.kind === "redirect") return c.redirect(loadedState.href, 302);

  if (loadedState.kind === "invalidQuery") {
    return () => (
      <Layout c={c} title={loadedState.title}>
        <NotFoundState
          icon="ti ti-alert-triangle"
          title={loadedState.title}
          description={loadedState.message}
          action={{ label: t.backToBase, href: `/app/grids/${baseShortId}`, icon: "ti ti-arrow-left" }}
        />
      </Layout>
    );
  }

  if (loadedState.kind !== "ok")
    return ssr.error(c, loadedState.kind === "accessDenied" ? 403 : 404, {
      description: loadedState.kind === "accessDenied" ? t.askBaseAdminForAccess : t.baseUnavailable,
      action: { label: t.allBases, href: "/app/grids" },
    });

  const state = loaded.state;
  if (!state) throw new Error("Workspace state projection is missing");
  state.initialNavigationExpansion = parseNavigationExpansion(c.req.header("Cookie"), state.base.id);

  const scope = gridsPageScope(state.base.id, state.route.kind === "records" ? state.route.initialSelectedRecord : null);
  // Route kinds rebuilt on UI v2; the others still render the v1 workspace until their part moves.
  if (state.route.kind === "overview" || state.route.kind === "empty") {
    const params = new URL(c.req.url).searchParams;
    const query = resourcesQuery(locale).parse(params).state;
    return () => (
      <Layout c={c} fullWidth ui="v2" title={state.title} context={{ scope }}>
        <RememberGridsPath />
        <BaseHome state={state} query={query} tab={homeTab(params, (state.navigation?.groups.length ?? 0) > 0)} />
      </Layout>
    );
  }

  if (state.route.kind === "records") {
    const now = new Date().toISOString();
    return () => (
      <Layout c={c} fullWidth ui="v2" title={state.title} context={{ scope }}>
        <RememberGridsPath />
        <RecordsScreen state={state} userId={user.id} now={now} />
      </Layout>
    );
  }

  return () => (
    <Layout c={c} fullWidth title={state.title} context={{ scope }}>
      <GridsWorkspace userId={user.id} state={state} />
    </Layout>
  );
});
