import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { getRuntimeContext } from "@valentinkolb/cloud/ssr";
import { currentActorUser, gateBaseAtAccess, gridsAccessContext } from "../../../api/permissions";
import { toPublicFields, toPublicTables, toPublicViews } from "../../../api/public-dto";
import { ssr } from "../../../config";
import { gridsService } from "../../../service";
import QueryReferenceWindow, { normalizeQueryReferenceTab } from "../../_components/query/QueryReferenceWindow";
import { serializeWorkspaceState } from "../../_components/workspace/workspace-state-serialization";
import { resolveGridsMessages } from "../../messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = resolveGridsMessages(getLocale(c));
  const baseSlug = c.req.param("baseId")!;
  return serializeWorkspaceState(
    baseSlug,
    async () => {
      const defaultTabParam = c.req.query("defaultTab");
      const routeTabParam = c.req.param("tab");
      const sourceId = c.req.param("sourceId");
      const defaultTab =
        normalizeQueryReferenceTab(routeTabParam) ?? normalizeQueryReferenceTab(defaultTabParam) ?? (sourceId ? "tables" : "basics");
      c.get("page").title = defaultTab === "workflows" ? t.workflowReference : defaultTab === "gql" ? t.gqlReference : t.gridsReference;
      const base = await gridsService.base.getByShortId(baseSlug);
      if (!base) return ssr.error(c, 404, { layout: "minimal" });

      const user = currentActorUser(c);
      if (!user) return ssr.error(c, 403, { layout: "minimal" });

      const gate = await gateBaseAtAccess(gridsAccessContext(c), base.id, "read");
      if (!gate.ok) return ssr.error(c, gate.error.status, { layout: "minimal" });

      const catalog = await gridsService.base.catalog({
        baseId: base.id,
        userId: user.id,
        userGroups: user.memberofGroupIds,
      });
      const recordCountsByTable = await gridsService.record.countByTable(catalog.tables.map((table) => table.id));
      const publicTables = await toPublicTables(catalog.tables);
      const publicTableIds = new Map<string, string>();
      for (const [index, table] of catalog.tables.entries()) {
        const publicTable = publicTables[index];
        if (publicTable) publicTableIds.set(table.id, publicTable.id);
      }
      const publicTableId = (internalId: string) => {
        const id = publicTableIds.get(internalId);
        if (!id) throw new Error("Missing public table ID");
        return id;
      };
      const publicFields = await toPublicFields(Object.values(catalog.fieldsByTable).flat());
      const publicViews = await toPublicViews(Object.values(catalog.viewsByTable).flat());
      const groupByTable = <T extends { tableId: string }>(items: readonly T[]) => {
        const grouped: Record<string, T[]> = {};
        for (const table of publicTables) grouped[table.id] = [];
        for (const item of items) {
          const tableItems = grouped[item.tableId] ?? [];
          tableItems.push(item);
          grouped[item.tableId] = tableItems;
        }
        return grouped;
      };
      const publicFieldsByTable = groupByTable(publicFields);
      const publicViewsByTable = groupByTable(publicViews);
      const publicRecordCountsByTable = Object.fromEntries(
        Object.entries(recordCountsByTable).map(([tableId, count]) => [publicTableId(tableId), count]),
      );
      const helpDocuments = getRuntimeContext(c).apps.find((registeredApp) => registeredApp.id === "grids")?.help?.documents ?? [];

      return () => (
        <QueryReferenceWindow
          baseId={base.shortId}
          baseName={base.name}
          tables={publicTables}
          fieldsByTable={publicFieldsByTable}
          viewsByTable={publicViewsByTable}
          recordCountsByTable={publicRecordCountsByTable}
          documents={helpDocuments}
          defaultTab={defaultTab}
          inspectedSourceId={sourceId}
        />
      );
    },
    c.req.raw.signal,
  );
});
