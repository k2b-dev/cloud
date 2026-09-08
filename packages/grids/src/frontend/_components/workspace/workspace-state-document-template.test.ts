import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { gridsService } from "../../../service";
import { loadGridsWorkspaceState } from "./workspace-state";

const loadWorkspaceState = (params: Parameters<typeof loadGridsWorkspaceState>[0]) =>
  loadGridsWorkspaceState(params, {
    latestMetadataEventCursor: async () => null,
    latestRecordEventCursor: async () => null,
  });

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  shortId: "BASE01",
  name: "Documents Base",
  description: null,
  documentDefaults: {},
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const documentTable = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "TABL01",
  baseId: base.id,
  kind: "stored" as const,
  name: "Invoices",
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" as const },
  auditPolicy: {},
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const template = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "TMPL01",
  tableId: documentTable.id,
  name: "Invoice",
  description: "Customer invoice.",
  source: `from table {${documentTable.shortId}}\nwhere record.id = '{{ record.id }}'\nlimit 1`,
  html: "<p>{{ record.id }}</p>",
  headerHtml: null,
  footerHtml: null,
  pageCss: null,
  enabled: true,
  position: 0,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const templateSummary = {
  id: template.id,
  shortId: template.shortId,
  tableId: template.tableId,
  name: template.name,
  description: template.description,
  enabled: template.enabled,
  position: template.position,
  createdAt: template.createdAt,
  updatedAt: template.updatedAt,
};

const document = {
  id: "66666666-6666-4666-8666-666666666666",
  shortId: "RUN001",
  baseId: base.id,
  tableId: documentTable.id,
  recordId: "55555555-5555-4555-8555-555555555555",
  filename: "invoice.pdf",
  templateId: template.id,
  workflowRunId: null,
  snapshotId: "77777777-7777-4777-8777-777777777777",
  documentNumber: "INV-001",
  tags: [],
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

let baseLevel: "none" | "read" | "write" = "none";

describe("loadGridsWorkspaceState — document templates use Base access", () => {
  beforeEach(() => {
    baseLevel = "none";
    spyOn(gridsService.base, "getByShortId").mockImplementation(async () => base as never);
    spyOn(gridsService.base, "catalog").mockImplementation(
      async () =>
        ({
          tables: [],
          tableLevels: {},
          fieldsByTable: {},
          viewsByTable: {},
          formsByTable: {},
          formLevels: {},
          formTables: [],
          sidebarForms: [],
          documentTemplatesByTable: { [documentTable.id]: [template] },
          documentTemplateLevels: { [template.id]: baseLevel },
          documentTemplateTables: [documentTable],
          sidebarDocumentTemplates: [{ template, tableId: documentTable.id }],
        }) as never,
    );
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => baseLevel);
    spyOn(gridsService.table, "getByShortIdForBase").mockImplementation(
      async (_baseId, publicId) => (documentTable.shortId === publicId ? documentTable : null) as never,
    );
    spyOn(gridsService.document, "getTemplateByShortIdForTable").mockImplementation(
      async (_tableId, publicId) => (template.shortId === publicId ? template : null) as never,
    );
    spyOn(gridsService.document, "browseDocumentsForTemplate").mockImplementation(
      async () =>
        ({
          path: [],
          folders: [],
          items: [document],
          total: 1,
          limit: 100,
          hasMore: false,
          nextCursor: null,
        }) as never,
    );
    spyOn(gridsService.document, "summarizeTemplate").mockImplementation(() => templateSummary as never);
    spyOn(gridsService.view, "getByShortIdForTable").mockImplementation(async () => null);
    spyOn(gridsService.workflow, "listForBase").mockImplementation(async () => []);
    spyOn(gridsService.workflow.launcher, "listForBase").mockImplementation(async () => []);
  });

  afterEach(() => mock.restore());

  test("rejects a document template route without Base read access", async () => {
    const state = await loadWorkspaceState({
      user: {
        id: "44444444-4444-4444-8444-444444444444",
        memberofGroupIds: [],
      },
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/document/${documentTable.shortId}/${template.shortId}?record=REC001`,
      activeDocumentTableSlug: documentTable.shortId,
      activeDocumentTemplateSlug: template.shortId,
    });

    expect(state).toEqual({ kind: "accessDenied", title: "Access denied", message: "No access to this base" });
  });

  test("marks document template routes writable with Base write access", async () => {
    baseLevel = "write";

    const state = await loadWorkspaceState({
      user: {
        id: "44444444-4444-4444-8444-444444444444",
        memberofGroupIds: [],
      },
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/document/${documentTable.shortId}/${template.shortId}`,
      activeDocumentTableSlug: documentTable.shortId,
      activeDocumentTemplateSlug: template.shortId,
      initialDocumentViewMode: "folders",
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.route.kind).toBe("documentTemplate");
    if (state.route.kind !== "documentTemplate") return;
    expect(state.route.canWriteTemplate).toBe(true);
    expect(state.route.initialDocumentViewMode).toBe("folders");
  });
});
