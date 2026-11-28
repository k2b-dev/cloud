import type { DocumentTemplateSummary } from "../../../contracts";
import type { Form, Table } from "../../../service";
import { gridsService } from "../../../service";
import { resolveBaseLevel } from "./workspace-state-access";
import type { AuthUser, WorkspaceCatalog } from "./workspace-state-model";

export const loadCatalog = async (baseId: string, user: AuthUser, includeCustomApps = false): Promise<WorkspaceCatalog> => {
  const catalogRaw = await gridsService.base.catalog({
    baseId,
    userId: user.id,
    userGroups: user.memberofGroupIds,
    customApps: includeCustomApps,
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

  // the workflows and (for who manages the base) the apps came with the catalog's one statement
  const allWorkflows = catalogRaw.workflows;
  const customApps = catalogRaw.customApps;
  const workflowLaunchers = includeCustomApps ? await gridsService.workflow.launcher.listForBase(baseId, true) : [];
  const baseLevel = await resolveBaseLevel(user, baseId);
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
