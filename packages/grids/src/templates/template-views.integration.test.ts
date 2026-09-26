import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { projectPublicWorkspaceState } from "../frontend/_components/workspace/workspace-public-state";
import { loadGridsWorkspaceState } from "../frontend/_components/workspace/workspace-state";
import { postgresTest, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { instantiate } from "../service/templates";
import { deleteTestWorkflowScope } from "../service/workflow-test-fixture";
import { getTemplates } from ".";

type ViewRow = { view_short_id: string; table_short_id: string; name: string };

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
});

/**
 * Mirrors the SSR view page (`frontend/[baseId]/table/[tableId]/view/[viewId]/page.tsx`):
 * load the workspace state for the view route, then project it to the public state that
 * gets serialized into the page. Both steps must succeed for every installed template view.
 */
describe("built-in template views", () => {
  for (const scenario of [
    { locale: "de", withSampleData: true },
    { locale: "en", withSampleData: false },
  ]) {
    for (const template of getTemplates(scenario.locale)) {
      const sharedViews = (template.views ?? []).filter((view) => view.shared);
      if (sharedViews.length === 0) continue;
      postgresTest(
        `${template.id}/${scenario.locale}/${scenario.withSampleData ? "sample" : "empty"}: every view renders`,
        async () => {
          const actorId = testUuid();
          await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
            VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Template owner', 'Template', 'Owner')`;
          const installed = await instantiate(template.id, { withSampleData: scenario.withSampleData }, actorId, scenario.locale);
          if (!installed.ok) throw new Error(installed.error.message);
          const baseId = installed.data.id;
          try {
            const [base] = await sql<Array<{ short_id: string }>>`SELECT short_id FROM grids.bases WHERE id = ${baseId}::uuid`;
            const views = await sql<ViewRow[]>`
              SELECT v.short_id AS view_short_id, t.short_id AS table_short_id, v.name
              FROM grids.views v
              JOIN grids.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
              WHERE t.base_id = ${baseId}::uuid AND v.deleted_at IS NULL
              ORDER BY v.name`;
            expect(views.map((view) => view.name)).toEqual(expect.arrayContaining(sharedViews.map((view) => view.name)));
            for (const view of views) {
              const state = await loadGridsWorkspaceState({
                user: { id: actorId, memberofGroupIds: [] },
                baseShortId: base!.short_id,
                href: `http://cloud.test/app/grids/${base!.short_id}/table/${view.table_short_id}/view/${view.view_short_id}`,
                activeTableSlug: view.table_short_id,
                activeViewSlug: view.view_short_id,
                locale: scenario.locale,
              });
              expect(state.kind, `${template.id} ${view.name} state`).toBe("ok");
              if (state.kind !== "ok") continue;
              expect(["records", "queryResultView"], `${template.id} ${view.name} route`).toContain(state.route.kind);
              const publicState = await projectPublicWorkspaceState(state);
              expect(publicState.route.kind).toBe(state.route.kind);
              expect(publicState.title.at(-1)?.title).toBe(view.name);
            }
          } finally {
            await deleteTestWorkflowScope(baseId);
            await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
          }
        },
        120_000,
      );
    }
  }
});
