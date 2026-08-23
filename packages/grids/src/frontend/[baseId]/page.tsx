import { NotFoundState } from "@k2b/ui";
import { type AuthContext, getDateConfig } from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import { publicCloudOrigin } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import { currentActorUser } from "../../api/permissions";
import { withInitialGqlResults } from "../../api/workspace-query-preview";
import { ssr } from "../../config";
import { parseDocumentViewMode } from "../_components/sidebar/GridsSettingsStore";
import GridsWorkspace from "../_components/workspace/GridsWorkspace";
import { projectPublicWorkspaceState } from "../_components/workspace/workspace-public-state";
import { loadGridsWorkspaceState } from "../_components/workspace/workspace-state";
import { serializeWorkspaceState } from "../_components/workspace/workspace-state-serialization";

export default ssr<AuthContext>(async (c) => {
  const user = currentActorUser(c);
  if (!user) {
    return () => (
      <Layout c={c} title={[{ title: "Grids", href: "/app/grids" }]}>
        <div class="paper p-8 max-w-md mx-auto mt-16 text-center text-dimmed">
          <i class="ti ti-lock text-sm" /> Sign in to open Grids.
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
      });
      return {
        loadedState,
        state: loadedState.kind === "ok" ? await projectPublicWorkspaceState(await withInitialGqlResults(c, loadedState)) : null,
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
          action={{ label: "Back to base", href: `/app/grids/${baseShortId}`, icon: "ti ti-arrow-left" }}
        />
      </Layout>
    );
  }

  if (loadedState.kind !== "ok") {
    // A base you may not open is found, just not yours — so no "404" numeral
    // there. Either way, offer the one place that always works.
    const denied = loadedState.kind === "accessDenied";
    if (!denied) c.status(404);
    return () => (
      <Layout c={c} title={loadedState.title}>
        <NotFoundState
          code={denied ? undefined : "404"}
          icon={denied ? "ti ti-lock" : undefined}
          title={loadedState.message}
          description={denied ? "Ask a base admin for access, or pick another base." : "This base may have been deleted or renamed."}
          action={{ label: "All bases", href: "/app/grids", icon: "ti ti-table" }}
        />
      </Layout>
    );
  }

  const state = loaded.state;
  if (!state) throw new Error("Workspace state projection is missing");
  const cloudUrl = publicCloudOrigin(await coreSettings.get<string>("app.url"));

  return () => (
    <Layout c={c} fullWidth title={state.title}>
      <GridsWorkspace state={state} cloudUrl={cloudUrl} />
    </Layout>
  );
});
