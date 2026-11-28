import type { PermissionLevel } from "@k2b/cloud/server";
import type { DocumentTemplateSummary } from "../../../contracts";
import type { Form, Table } from "../../../service";
import { gridsService } from "../../../service";
import type { AuthUser, WorkspaceCatalog } from "./workspace-state-model";

/**
 * What the base's navigation lists, for who has `baseLevel` on it (the level the request read already). The app
 * runners are read only for the app page (`launchers`), the one page whose builder offers them.
 */
export const loadCatalog = async (
  baseId: string,
  user: AuthUser,
  baseLevel: PermissionLevel,
  options: { customApps: boolean; launchers: boolean },
): Promise<WorkspaceCatalog> => {
  const catalogRaw = await gridsService.base.catalog({
    baseId,
    userId: user.id,
    userGroups: user.memberofGroupIds,
    level: baseLevel,
  });
  const tables = catalogRaw.tables;
  const formTables = catalogRaw.formTables ?? [];
  const documentTemplateTables = catalogRaw.documentTemplateTables ?? [];
  const tableById = Object.fromEntries([...tables, ...formTables, ...documentTemplateTables].map((table) => [table.id, table]));
  const sidebarForms: Array<{ form: Form; table: Table }> = [];
  for (const { form, tableId } of catalogRaw.sidebarForms) {
    const table = tableById[tableId];
    if (table) sidebarForms.push({ form, table });
  }
  sidebarForms.sort((left, right) => left.form.name.localeCompare(right.form.name, undefined, { sensitivity: "base" }));
  const documentTemplatesByTable = Object.fromEntries(
    Object.entries(catalogRaw.documentTemplatesByTable ?? {}).map(([tableId, templates]) => [
      tableId,
      templates.map(gridsService.document.summarizeTemplate),
    ]),
  );
  const sidebarDocumentTemplates: Array<{ template: DocumentTemplateSummary; table: Table }> = [];
  for (const { template, tableId } of catalogRaw.sidebarDocumentTemplates ?? []) {
    const table = tableById[tableId];
    if (table) sidebarDocumentTemplates.push({ template: gridsService.document.summarizeTemplate(template), table });
  }
  sidebarDocumentTemplates.sort((left, right) => left.template.name.localeCompare(right.template.name, undefined, { sensitivity: "base" }));

  const [allWorkflows, workflowLaunchers, customApps] = await Promise.all([
    gridsService.workflow?.listForBase ? gridsService.workflow.listForBase(baseId) : Promise.resolve([]),
    options.customApps && options.launchers ? gridsService.workflow.launcher.listForBase(baseId, true) : Promise.resolve([]),
    options.customApps ? gridsService.customApp.listSummariesByBase(baseId) : Promise.resolve([]),
  ]);
  const workflowLevels = Object.fromEntries(allWorkflows.map((workflow) => [workflow.id, baseLevel]));
  const workflows = allWorkflows
    .filter((workflow) => gridsService.permission.hasAtLeast(workflowLevels[workflow.id] ?? "none", "read"))
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  return {
    customApps,
    workflows,
    workflowLaunchers: workflowLaunchers.filter(
      (launcher) =>
        (launcher.config.kind === "customApp" || launcher.config.kind === "scanner") &&
        launcher.enabled &&
        launcher.deletedAt === null &&
        launcher.diagnostics.length === 0 &&
        workflows.some((workflow) => workflow.id === launcher.workflowId && workflow.revision === launcher.validatedRevision),
    ),
    workflowLevels,
    tables,
    tableLevels: catalogRaw.tableLevels,
    fieldsByTable: catalogRaw.fieldsByTable,
    viewsByTable: catalogRaw.viewsByTable,
    formsByTable: catalogRaw.formsByTable,
    documentTemplatesByTable,
    documentTemplateLevels: catalogRaw.documentTemplateLevels ?? {},
    tableShortIds: Object.fromEntries([...tables, ...formTables, ...documentTemplateTables].map((table) => [table.id, table.shortId])),
    sidebarForms,
    sidebarDocumentTemplates,
  };
};

export const canUseEditModeForCatalog = (catalog: WorkspaceCatalog, user: AuthUser, canManageBase: boolean, canCreateTables: boolean) =>
  canCreateTables ||
  catalog.tables.some((table) => gridsService.permission.hasAtLeast(catalog.tableLevels[table.id] ?? "none", "admin")) ||
  Object.values(catalog.documentTemplateLevels).some((level) => gridsService.permission.hasAtLeast(level, "admin")) ||
  Object.values(catalog.workflowLevels).some((level) => gridsService.permission.hasAtLeast(level, "admin"));
