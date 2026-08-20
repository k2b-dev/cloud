import { projectCustomApp, projectCustomAppSummaries } from "../../../api/custom-apps";
import {
  projectDocumentRunSummaries,
  projectDocumentTemplateSummaries,
  projectDocumentTemplates,
  projectRecordSnapshotSummaries,
} from "../../../api/documents-api-shared";
import { toPublicGqlResponse } from "../../../api/gql-public";
import { toPublicAuditEntries } from "../../../api/public-audit";
import {
  toPublicBase,
  toPublicFields,
  toPublicFiles,
  toPublicForms,
  toPublicRecords,
  toPublicTableQueryResponse,
  toPublicTables,
  toPublicViews,
} from "../../../api/public-dto";
import { toPublicRecordQuery } from "../../../api/public-query";
import {
  toPublicWorkflowLaunchers,
  toPublicWorkflowRun,
  toPublicWorkflowRuns,
  toPublicWorkflowStats,
  toPublicWorkflowSteps,
  toPublicWorkflows,
  toPublicWorkflowTriggerState,
} from "../../../api/workflow-api-shared";
import type { Field } from "../../../contracts";
import { projectPublicId, projectPublicIds } from "../../../service/public-resources";
import type { PublicOkWorkspaceState, PublicWorkspaceCatalog, PublicWorkspaceRoute } from "./workspace-public-state-model";
import type { OkWorkspaceState, WorkspaceCatalog, WorkspaceRecordDetail, WorkspaceWorkflowRunDetail } from "./workspace-state-model";

const required = <T>(value: T | null | undefined, resource: string): T => {
  if (!value) throw new Error(`Cannot project workspace ${resource}`);
  return value;
};

const rekey = <T>(values: Record<string, T>, ids: ReadonlyMap<string, string>): Record<string, T> =>
  Object.fromEntries(Object.entries(values).map(([id, value]) => [required(ids.get(id), `map key ${id}`), value]));

const projectCatalog = async (catalog: WorkspaceCatalog): Promise<PublicWorkspaceCatalog> => {
  const fields = Object.values(catalog.fieldsByTable).flat();
  const views = Object.values(catalog.viewsByTable).flat();
  const forms = Object.values(catalog.formsByTable).flat();
  const templates = Object.values(catalog.documentTemplatesByTable).flat();
  const allTables = [
    ...new Map(
      [
        ...catalog.tables,
        ...catalog.sidebarForms.map((item) => item.table),
        ...catalog.sidebarDocumentTemplates.map((item) => item.table),
      ].map((table) => [table.id, table]),
    ).values(),
  ];
  const allForms = [...new Map([...forms, ...catalog.sidebarForms.map((item) => item.form)].map((form) => [form.id, form])).values()];
  const allTemplates = [
    ...new Map(
      [...templates, ...catalog.sidebarDocumentTemplates.map((item) => item.template)].map((template) => [template.id, template]),
    ).values(),
  ];
  // These projections share Bun's default SQL pool. Keeping the small indexed
  // reads sequential avoids pool saturation leaving completed queries pending.
  const allPublicTables = await toPublicTables(allTables);
  const publicFields = await toPublicFields(fields);
  const publicViews = await toPublicViews(views);
  const allPublicForms = await toPublicForms(allForms);
  const allPublicTemplates = await projectDocumentTemplateSummaries(allTemplates);
  const customApps = await projectCustomAppSummaries(catalog.customApps);
  const workflows = await toPublicWorkflows(catalog.workflows);
  const workflowLaunchers = await toPublicWorkflowLaunchers(catalog.workflowLaunchers);
  const tableIds = new Map(allTables.map((table, index) => [table.id, allPublicTables[index]!.id]));
  const workflowIds = new Map(catalog.workflows.map((workflow, index) => [workflow.id, workflows[index]!.id]));
  const templateIds = await projectPublicIds(
    "documentTemplate",
    allTemplates.map((template) => template.id),
  );
  const groupByTable = <T extends { tableId: string }>(items: readonly T[]) => {
    const grouped: Record<string, T[]> = {};
    for (const item of items) {
      grouped[item.tableId] ??= [];
      grouped[item.tableId]!.push(item);
    }
    return grouped;
  };
  const tableById = new Map(allPublicTables.map((table) => [table.id, table]));
  const formById = new Map(allPublicForms.map((form) => [form.id, form]));
  const templateById = new Map(allPublicTemplates.map((template) => [template.id, template]));
  const tables = allPublicTables.slice(0, catalog.tables.length);
  const publicForms = allPublicForms.slice(0, forms.length);
  const publicTemplates = allPublicTemplates.slice(0, templates.length);
  return {
    customApps,
    workflows,
    workflowLaunchers,
    workflowLevels: rekey(catalog.workflowLevels, workflowIds),
    tables,
    tableLevels: rekey(catalog.tableLevels, tableIds),
    fieldsByTable: groupByTable(publicFields),
    viewsByTable: groupByTable(publicViews),
    formsByTable: groupByTable(publicForms),
    documentTemplatesByTable: groupByTable(publicTemplates),
    documentTemplateLevels: rekey(catalog.documentTemplateLevels, templateIds),
    sidebarForms: catalog.sidebarForms.map(({ form, table }) => ({
      form: required(formById.get(form.shortId), `form ${form.id}`),
      table: required(tableById.get(required(tableIds.get(table.id), `table ${table.id}`)), `table ${table.id}`),
    })),
    sidebarDocumentTemplates: catalog.sidebarDocumentTemplates.map(({ template, table }) => ({
      template: required(templateById.get(template.shortId), `document template ${template.id}`),
      table: required(tableById.get(required(tableIds.get(table.id), `table ${table.id}`)), `table ${table.id}`),
    })),
  };
};

export const projectPublicWorkspaceRecordDetail = async (detail: WorkspaceRecordDetail, fields: readonly Field[]) => {
  const files = Object.values(detail.filesByField).flat();
  const [publicFiles, fieldIds, relationRecordIds, documentRuns, snapshots] = await Promise.all([
    toPublicFiles(files),
    projectPublicIds("field", Object.keys(detail.filesByField)),
    projectPublicIds("record", Object.keys(detail.relationLabels)),
    projectDocumentRunSummaries(detail.documentRuns),
    projectRecordSnapshotSummaries(detail.snapshots),
  ]);
  const filesByField: Record<string, typeof publicFiles> = {};
  let offset = 0;
  for (const [fieldId, fieldFiles] of Object.entries(detail.filesByField)) {
    filesByField[required(fieldIds.get(fieldId), `field ${fieldId}`)] = publicFiles.slice(offset, offset + fieldFiles.length);
    offset += fieldFiles.length;
  }
  return {
    ...detail,
    recordId: required(await projectPublicId("record", detail.recordId), "record detail"),
    relationLabels: Object.fromEntries(
      Object.entries(detail.relationLabels).flatMap(([recordId, label]) => {
        const publicId = relationRecordIds.get(recordId);
        return publicId ? [[publicId, label]] : [];
      }),
    ),
    filesByField,
    documentRuns,
    snapshots,
    auditEntries: await toPublicAuditEntries(detail.auditEntries, fields),
  };
};

export const projectPublicWorkspaceWorkflowRunDetail = async (detail: WorkspaceWorkflowRunDetail) => {
  const run = await toPublicWorkflowRun(detail.run);
  return {
    ...detail,
    run,
    steps: (await toPublicWorkflowSteps({ items: detail.steps, truncated: detail.stepsTruncated }, run.id)).items,
    documents: { ...detail.documents, items: await projectDocumentRunSummaries(detail.documents.items) },
  };
};

const projectRoute = async (state: OkWorkspaceState, catalog: PublicWorkspaceCatalog): Promise<PublicWorkspaceRoute> => {
  const route = state.route;
  if (route.kind === "empty") return route;
  if (route.kind === "customApp") {
    return {
      ...route,
      app: await projectCustomApp(route.app),
    };
  }
  if (route.kind === "records") {
    const [activeTable] = await toPublicTables([route.activeTable]);
    const [activeView] = route.activeView ? await toPublicViews([route.activeView]) : [null];
    const fields = await toPublicFields(route.fields);
    const forms = await toPublicForms(route.formsForTable);
    const initialData = await toPublicTableQueryResponse(route.initialData, route.fields);
    const records = await toPublicRecords(route.initialSelectedRecord ? [route.initialSelectedRecord] : [], route.fields);
    const templates = await projectDocumentTemplateSummaries(route.documentTemplates);
    const launchers = await toPublicWorkflowLaunchers([...route.bulkSelectionLaunchers, ...route.recordActionLaunchers]);
    const bulkLaunchers = launchers.slice(0, route.bulkSelectionLaunchers.length);
    const recordLaunchers = launchers.slice(route.bulkSelectionLaunchers.length);
    const otherTableIds = await projectPublicIds(
      "table",
      route.otherTables.map((table) => table.id),
    );
    const selectedRecordId = route.initialState.selectedRecordId
      ? required(await projectPublicId("record", route.initialState.selectedRecordId), "selected record")
      : null;
    const detail = route.initialSelectedRecordDetail;
    const publicDetail = detail ? await projectPublicWorkspaceRecordDetail(detail, route.fields) : null;
    const publicQuery = await toPublicRecordQuery(route.initialState.query, route.fields);
    const publicActiveQuery = route.activeRecordQuery ? await toPublicRecordQuery(route.activeRecordQuery, route.fields) : null;
    const publicActiveTable = required(activeTable, "active table");
    return {
      ...route,
      activeTable: publicActiveTable,
      activeView: activeView
        ? {
            ...activeView,
            query: await toPublicRecordQuery(route.activeView!.query, route.fields),
            displayConfig: activeView.ui.displayConfig ?? { mode: "table" },
          }
        : null,
      fields,
      formsForTable: forms,
      otherTables: route.otherTables.map((table) => ({ ...table, id: required(otherTableIds.get(table.id), `table ${table.id}`) })),
      initialState: {
        ...route.initialState,
        query: publicQuery,
        selectedRecordId,
        search: { ...route.initialState.search, fieldIds: publicQuery.search?.fieldIds ?? [] },
      },
      initialData,
      initialSelectedRecord: records[0] ?? null,
      initialSelectedRecordDetail: publicDetail,
      documentTemplates: templates,
      relationLabels: initialData.relationLabels ?? {},
      activeViewColumns: publicQuery.columns,
      searchableFields: fields.filter((_field, index) =>
        route.searchableFields.some((candidate) => candidate.id === route.fields[index]?.id),
      ),
      activeRecordQuery: publicActiveQuery,
      displayConfig: activeView?.ui.displayConfig ?? publicActiveTable.displayConfig,
      bulkSelectionLaunchers: bulkLaunchers.map((launcher, index) => ({
        ...launcher,
        workflowRevision: route.bulkSelectionLaunchers[index]!.workflowRevision,
      })),
      recordActionLaunchers: recordLaunchers.map((launcher, index) => ({
        ...launcher,
        workflowRevision: route.recordActionLaunchers[index]!.workflowRevision,
        correctionPrefillFieldCount: route.recordActionLaunchers[index]!.correctionPrefillFieldCount,
      })),
    };
  }
  if (route.kind === "queryResultView") {
    const [activeTable] = await toPublicTables([route.activeTable]);
    const [activeView] = await toPublicViews([route.activeView]);
    return {
      ...route,
      activeTable: required(activeTable, "query result table"),
      activeView: required(activeView, "query result view"),
      fields: await toPublicFields(route.fields),
      initialResult: route.initialResult ? await toPublicGqlResponse(route.initialResult) : null,
    };
  }
  if (route.kind === "query") {
    const currentSource = route.currentSource
      ? route.currentSource.kind === "table"
        ? { ...route.currentSource, tableId: required(await projectPublicId("table", route.currentSource.tableId), "query table") }
        : { ...route.currentSource, viewId: required(await projectPublicId("view", route.currentSource.viewId), "query view") }
      : undefined;
    return {
      ...route,
      currentSource,
      initialPreview: route.initialPreview ? await toPublicGqlResponse(route.initialPreview) : route.initialPreview,
    };
  }
  if (route.kind === "documentTemplate") {
    const [table] = await toPublicTables([route.table]);
    const [template] = await projectDocumentTemplateSummaries([route.template]);
    const editable = route.editableTemplate ? (await projectDocumentTemplates([route.editableTemplate]))[0]! : null;
    return {
      ...route,
      table: required(table, "document table"),
      template: required(template, "document template"),
      editableTemplate: editable,
      initialRecordId: route.initialRecordId ? required(await projectPublicId("record", route.initialRecordId), "document record") : null,
      initialBrowserPage: {
        ...route.initialBrowserPage,
        items: await projectDocumentRunSummaries(route.initialBrowserPage.items),
      },
    };
  }
  const workflows = await toPublicWorkflows(route.activeWorkflow ? [route.activeWorkflow] : []);
  const overviewRuns = await toPublicWorkflowRuns(route.initialOverview.runs.items);
  const overviewLaunchers = await toPublicWorkflowLaunchers(route.initialOverview.launchers);
  const selected = route.initialSelectedRun;
  return {
    ...route,
    activeWorkflow: workflows[0] ?? null,
    selectedRunId: route.selectedRunId ? required(await projectPublicId("workflowRun", route.selectedRunId), "workflow run") : null,
    initialOverview: {
      ...route.initialOverview,
      stats: await toPublicWorkflowStats(route.initialOverview.stats),
      runs: { ...route.initialOverview.runs, items: overviewRuns },
      launchers: overviewLaunchers,
      triggerState: route.initialOverview.triggerState ? await toPublicWorkflowTriggerState(route.initialOverview.triggerState) : null,
    },
    initialSelectedRun: selected ? await projectPublicWorkspaceWorkflowRunDetail(selected) : null,
  };
};

export const projectPublicWorkspaceState = async (state: OkWorkspaceState): Promise<PublicOkWorkspaceState> => {
  const catalog = await projectCatalog(state.catalog);
  const { baseShortId: _baseShortId, ...rest } = state;
  return { ...rest, base: toPublicBase(state.base), catalog, route: await projectRoute(state, catalog) };
};
