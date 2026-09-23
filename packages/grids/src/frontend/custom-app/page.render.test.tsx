import { expect, test } from "bun:test";
import { type ComponentProps, createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../_components/ssr-test-plugin";

const { CustomAppPage } = await import("./page");
const timestamp = "2026-09-17T12:00:00.000Z";

const fixture = (): ComponentProps<typeof CustomAppPage> => {
  const page = {
    id: "detail",
    title: "Detail",
    navigation: { visible: true },
    parameters: {},
    rows: [
      {
        id: "main",
        columns: [
          {
            id: "body",
            span: 12,
            blocks: [
              {
                id: "identity",
                type: "record" as const,
                fieldIds: [],
                editableFieldIds: [],
                documents: { templateIds: ["DOC001"], preview: false },
              },
              { id: "issue", type: "actions" as const, actions: [] },
            ],
          },
        ],
      },
    ],
  };
  return {
    definition: {
      schemaVersion: 5,
      kind: "grids.custom-app",
      id: "APP001",
      baseId: "BASE01",
      name: "Demo",
      startPageId: "detail",
      pages: [page],
    },
    page,
    shortId: "APP001",
    results: new Map(),
    metrics: new Map(),
    charts: new Map(),
    forms: new Map(),
    commentEndpoints: new Map(),
    rowActions: new Map(),
    recordEndpoints: new Map(),
    recordUpdateEndpoints: new Map(),
    documentPreviews: new Map(),
    renderedHtml: new Map(),
    dateConfig: { timeZone: "UTC" },
    markdownContext: {
      "auth.id": null,
      "auth.name": null,
      "auth.username": null,
      "auth.email": null,
      "auth.subjects": [],
      "page.id": "detail",
      "page.title": "Detail",
      "page.url": "/apps/APP001/detail",
      "app.id": "APP001",
      "app.name": "Demo",
      "base.id": "BASE01",
      "base.name": "Demo",
      "time.now": timestamp,
      "time.today": "2026-09-17",
      "time.timeZone": "UTC",
    },
    scanners: new Map(),
    sidebarActions: [],
    signedIn: true,
    pageRecords: new Map([
      [
        "identity",
        {
          tableName: "Invoices",
          auditPolicy: {},
          fields: [],
          relationLabels: {},
          fileEndpoints: {},
          filesByField: {},
          record: {
            id: "REC001",
            tableId: "TABLE1",
            data: {},
            version: 1,
            deletedAt: null,
            createdBy: null,
            updatedBy: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      ],
    ]),
    documents: new Map([
      [
        "identity",
        [
          {
            id: "PDF001",
            baseId: "BASE01",
            tableId: "TABLE1",
            recordId: "REC001",
            templateId: "DOC001",
            workflowId: null,
            workflowRunId: null,
            number: "RE-001",
            filename: "RE-001.pdf",
            createdAt: timestamp,
            createdBy: null,
            tags: [],
            renderer: { kind: "html" },
            validationStatus: null,
            primaryArtifactKey: "pdf",
            artifacts: [],
            sourceRecordCount: 1,
            dataSnapshot: null,
            downloadUrl: "/record-document.pdf",
          },
        ],
      ],
    ]),
    actions: new Map([
      [
        "issue",
        [
          {
            id: "issue",
            kind: "workflow",
            launcherId: "ISSUE1",
            label: "Issue invoice",
            endpoint: "/issue",
            background: {
              acceptedMessage: "Creation requested",
              state: {
                status: "ready",
                document: { id: "PDF001", number: "RE-001", blockId: "identity" },
                downloadUrl: "/ready-document.pdf",
              },
            },
          },
        ],
      ],
    ]),
  };
};

test("ready action yields to the matching readable document, retaining its fallback otherwise", () => {
  const input = fixture();
  const render = () => renderToString(() => createComponent(CustomAppPage, input));
  expect(render()).toContain("/record-document.pdf");
  expect(render()).not.toContain("/ready-document.pdf");
  input.documents.clear();
  expect(render()).toContain("/ready-document.pdf");
  input.documents = fixture().documents;
  input.documents.get("identity")![0]!.id = "PDF002";
  expect(render()).toContain("/ready-document.pdf");
  input.documents = fixture().documents;
  input.pageRecords.clear();
  expect(render()).toContain("/ready-document.pdf");
});

test("an older displayed document never conceals running work or recovery", () => {
  const input = fixture();
  const action = input.actions.get("issue")![0]!;
  if (action.kind !== "workflow" || !action.background) throw new Error("Missing fixture action");
  for (const status of ["running", "failed", "missing", "attention"] as const) {
    action.background.state = { status };
    const html = renderToString(() => createComponent(CustomAppPage, input));
    expect(html).toContain("/record-document.pdf");
    expect(html).toContain(status === "running" ? "Creation requested" : status === "attention" ? 'role="alert"' : "<button");
  }
});
