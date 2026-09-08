import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext, PermissionLevel } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import type { Document } from "../contracts";
import { gridsService } from "../service";
import * as publicResources from "../service/public-resources";
import { createDocumentsApi } from "./documents";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const recordId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const snapshotId = "66666666-6666-4666-8666-666666666666";
const documentId = "77777777-7777-4777-8777-777777777777";
const fieldId = "88888888-8888-4888-8888-888888888888";
const relationFieldId = "99999999-9999-4999-8999-999999999999";
const relatedRecordId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const basePublicId = "BASE01";
const tablePublicId = "TABL01";
const templatePublicId = "TMPL01";
const recordPublicId = "RECD01";
const snapshotPublicId = "SNAP01";
const documentPublicId = "DOC001";
const fieldPublicId = "FELD01";
const relationFieldPublicId = "RELA01";
const relatedRecordPublicId = "RECD02";
const filePublicId = "FILE01";

const publicToInternal = new Map([
  [basePublicId, baseId],
  [tablePublicId, tableId],
  [templatePublicId, templateId],
  [recordPublicId, recordId],
  [snapshotPublicId, snapshotId],
  [documentPublicId, documentId],
  [fieldPublicId, fieldId],
  [relationFieldPublicId, relationFieldId],
  [relatedRecordPublicId, relatedRecordId],
  [filePublicId, fileId],
]);
const internalToPublic = new Map([...publicToInternal].map(([publicId, internalId]) => [internalId, publicId]));
const publicResourceMocks = {
  resolvePublicId: async (_type: string, publicId: string) => publicToInternal.get(publicId) ?? null,
  resolvePublicIds: async (_type: string, publicIds: readonly string[]) =>
    new Map(publicIds.flatMap((publicId) => (publicToInternal.has(publicId) ? [[publicId, publicToInternal.get(publicId)!]] : []))),
  projectPublicIds: async (_type: string, internalIds: readonly string[]) =>
    new Map(
      internalIds.flatMap((internalId) => (internalToPublic.has(internalId) ? [[internalId, internalToPublic.get(internalId)!]] : [])),
    ),
};

const user: User = {
  id: userId,
  uid: "document-render-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Document",
  sn: "Render",
  displayName: "Document Render",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const table = { id: tableId, shortId: tablePublicId, baseId, name: "Invoices" };
const template = {
  id: templateId,
  shortId: templatePublicId,
  tableId,
  name: "Invoice July",
  description: null,
  source: `from table {${tablePublicId}}`,
  renderer: {
    kind: "html" as const,
    body: "<p>{{ record.id }}</p>",
    numberTemplate: "{{ template.id }}-{{ document.id }}",
    filenameTemplate: "{{ document.number }}.pdf",
  },
  enabled: true,
  position: 0,
  createdBy: userId,
  updatedBy: userId,
  deletedAt: null,
  createdAt: "2026-07-11T08:00:00.000Z",
  updatedAt: "2026-07-11T08:00:00.000Z",
};
const disabledTemplate = { ...template, enabled: false };
const profileTemplate = {
  ...template,
  renderer: {
    kind: "profile" as const,
    id: "test.statement",
    version: 1,
    inputTemplate: '{"title":"Invoice","net":"100.00","tax":"19.00"}',
  },
};
const record = { id: recordId, values: { total: 42 } };
const fields = [
  { id: fieldId, shortId: fieldPublicId, tableId, type: "number" },
  { id: relationFieldId, shortId: relationFieldPublicId, tableId, type: "relation" },
];
const columns = [{ key: relationFieldId, label: "Customer", tableId, fieldId: relationFieldId, type: "relation", sqlType: "uuid" }];
const queryRows = [{ recordId, tableId, [relationFieldId]: relatedRecordId, Customer: relatedRecordId, note: baseId }];
const liveData = {
  record: { id: recordId, tableId, version: 1, data: { [fieldId]: 42, [relationFieldId]: relatedRecordId }, meta: {} },
  table: { id: tableId, shortId: tablePublicId, name: table.name },
  query: { columns, rows: queryRows },
  rows: queryRows,
  columns,
  template: { id: templatePublicId, name: template.name },
  date: {},
  images: [{ fieldId, fieldName: "Receipt", fileId, filename: "receipt.png", mimeType: "image/png", sizeBytes: 12, url: "data:" }],
  primaryImage: { fieldId, fieldName: "Receipt", fileId, filename: "receipt.png", mimeType: "image/png", sizeBytes: 12, url: "data:" },
  app: {},
  business: {},
  document: { id: "draft", number: null },
  snapshot: null,
};
const enrichedData = { ...liveData, document: { ...liveData.document, number: "draft" } };
const publicEnrichedData = {
  ...enrichedData,
  record: {
    ...liveData.record,
    id: recordPublicId,
    tableId: tablePublicId,
    data: { [fieldPublicId]: 42, [relationFieldPublicId]: relatedRecordPublicId },
  },
  table: { id: tablePublicId, name: table.name },
  query: {
    columns: [{ ...columns[0], key: relationFieldPublicId, tableId: tablePublicId, fieldId: relationFieldPublicId }],
    rows: [
      {
        recordId: recordPublicId,
        tableId: tablePublicId,
        [relationFieldPublicId]: relatedRecordPublicId,
        Customer: relatedRecordPublicId,
        note: baseId,
      },
    ],
  },
  columns: [{ ...columns[0], key: relationFieldPublicId, tableId: tablePublicId, fieldId: relationFieldPublicId }],
  rows: [
    {
      recordId: recordPublicId,
      tableId: tablePublicId,
      [relationFieldPublicId]: relatedRecordPublicId,
      Customer: relatedRecordPublicId,
      note: baseId,
    },
  ],
  images: [{ ...liveData.images[0], fieldId: fieldPublicId, fileId: filePublicId }],
  primaryImage: { ...liveData.images[0], fieldId: fieldPublicId, fileId: filePublicId },
};
const expectPublicPreviewData = (value: unknown) => {
  expect(value).toEqual(publicEnrichedData);
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('"shortId"');
  for (const internalId of [tableId, recordId, relatedRecordId, fieldId, relationFieldId, fileId]) {
    expect(serialized).not.toContain(internalId);
  }
  // UUID-shaped user values remain data; projection is driven by typed resource positions only.
  expect(serialized).toContain(baseId);
};
const snapshot = {
  id: snapshotId,
  baseId,
  tableId,
  recordId,
  root: record,
  graph: {},
  createdBy: userId,
  createdAt: "2026-07-11T08:00:00.000Z",
};
const document: Document = {
  id: documentId,
  shortId: documentPublicId,
  templateId,
  workflowRunId: null,
  snapshotId,
  baseId,
  tableId,
  recordId,
  documentNumber: "DOC-001",
  filename: "Invoice July.pdf",
  tags: ["finance"],
  templateSnapshot: template,
  renderData: { ...liveData, snapshot },
  artifacts: [{ key: "pdf", fileId, filename: "Invoice July.pdf", mimeType: "application/pdf", sizeBytes: 4, sha256: "a".repeat(64) }],
  profile: null,
  validationStatus: null,
  createdBy: userId,
  createdAt: "2026-07-11T08:00:00.000Z",
};
const pdfBytes = new Uint8Array([37, 80, 68, 70]);
const dateConfig = { timeZone: "UTC", locale: "en", firstDayOfWeek: 1 };

const forbiddenResponse = {
  message: "You do not have permission to access this resource.",
  code: "FORBIDDEN",
};

let baseLevel: PermissionLevel = "admin";
let currentTable: typeof table | null = table;
let currentTemplate: typeof template | typeof profileTemplate | null = template;
let currentRecord: typeof record | null = record;
let liveResult:
  | { ok: true; data: { source: string; columns: unknown[]; rows: unknown[]; data: typeof liveData } }
  | {
      ok: false;
      error: { message: string; status: 400 | 404 | 500 };
    };
let metadataResult: { ok: true; data: { data: typeof enrichedData } } | { ok: false; error: { message: string; status: 400 | 500 } };
let htmlResult: { ok: true; data: string } | { ok: false; error: { message: string; status: 400 | 500 } };
let previewPdfResult:
  | { ok: true; pdf: { pdf: Uint8Array } }
  | { ok: false; error: { message: string; phase: "html" | "pdf"; code: string; status: 400 | 500 | 502 } };
let createResult: { ok: true; data: typeof document } | { ok: false; error: { message: string; status: 400 | 500 | 502 } };
let permissionChecks: PermissionLevel[] = [];
let liveInputs: unknown[] = [];
let metadataInputs: unknown[] = [];
let htmlInputs: unknown[][] = [];
let previewPdfInputs: unknown[][] = [];
let createInput: unknown;
let callOrder: string[] = [];

const authenticated: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};
const denyAuthentication: MiddlewareHandler<AuthContext> = async (c) => c.json({ message: "Authentication required" }, 401);

const app = () => new Hono<AuthContext>().route("/documents", createDocumentsApi({ requireAuthenticated: authenticated }));
const deniedApp = () => new Hono<AuthContext>().route("/documents", createDocumentsApi({ requireAuthenticated: denyAuthentication }));
const path = (suffix: string) => `/documents${suffix}`;
const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const draftBody = {
  source: ` from table {${tablePublicId}} `,
  renderer: {
    kind: "html",
    body: " <p>Draft</p> ",
    header: " <header>Draft</header> ",
    numberTemplate: "{{ template.id }}-{{ document.id }}",
    filenameTemplate: "{{ document.number }}.pdf",
  },
  recordId: recordPublicId,
};
const recordBody = { recordId: recordPublicId, filename: " Custom invoice.pdf ", tags: ["finance", "july"] };
const generateBody = { ...recordBody, idempotencyKey: "invoice-july-v1" };

const publicIdOpenApiSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9]{6}$",
};
const draftRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", minLength: 1, maxLength: 20_000 },
    renderer: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", const: "html" },
            body: { type: "string", minLength: 1, maxLength: 200_000 },
            header: { type: "string", minLength: 1, maxLength: 50_000 },
            footer: { type: "string", minLength: 1, maxLength: 50_000 },
            css: { type: "string", minLength: 1, maxLength: 50_000 },
            numberTemplate: { type: "string", minLength: 1, maxLength: 5_000 },
            filenameTemplate: { type: "string", minLength: 1, maxLength: 5_000 },
          },
          required: ["kind", "body", "numberTemplate", "filenameTemplate"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", const: "profile" },
            id: { type: "string", pattern: "^[a-z][a-z0-9.-]{2,99}$" },
            version: { type: "integer", exclusiveMinimum: 0, maximum: 9007199254740991 },
            inputTemplate: { type: "string", minLength: 1, maxLength: 200_000 },
          },
          required: ["kind", "id", "version", "inputTemplate"],
        },
      ],
    },
    recordId: publicIdOpenApiSchema,
  },
  required: ["source", "renderer", "recordId"],
};
const recordRequestSchema = {
  type: "object",
  properties: {
    recordId: publicIdOpenApiSchema,
    filename: { type: "string", minLength: 1, maxLength: 255 },
    tags: {
      default: [],
      maxItems: 20,
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
  },
  required: ["recordId"],
};
const generateRequestSchema = {
  ...recordRequestSchema,
  properties: {
    ...recordRequestSchema.properties,
    idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["recordId", "idempotencyKey"],
};
const previewResponseSchema = {
  type: "object",
  properties: {
    html: { type: "string" },
    source: { type: "string" },
    data: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
  },
  required: ["html", "source", "data"],
};
const errorResponseSchema = {
  type: "object",
  properties: { message: { type: "string" }, code: { type: "string" } },
  required: ["message"],
};
const jsonSchemaResponse = (description: string, schema: unknown) => ({
  description,
  content: { "application/json": { schema } },
});
const forbiddenOpenApiResponse = jsonSchemaResponse("Forbidden", errorResponseSchema);

const renderRoutes = [
  ["/templates/by-table/{tableId}/preview-draft", draftRequestSchema, { description: "Draft PDF preview" }],
  [
    "/templates/by-table/{tableId}/preview-data-draft",
    draftRequestSchema,
    jsonSchemaResponse("Draft document preview data", previewResponseSchema),
  ],
  ["/templates/{templateId}/preview-draft", draftRequestSchema, { description: "Draft PDF preview" }],
  [
    "/templates/{templateId}/preview-data-draft",
    draftRequestSchema,
    jsonSchemaResponse("Draft document preview data", previewResponseSchema),
  ],
  ["/templates/{templateId}/preview", recordRequestSchema, jsonSchemaResponse("Rendered HTML preview", previewResponseSchema)],
  ["/templates/{templateId}/preview-pdf", recordRequestSchema, { description: "PDF preview" }],
  ["/templates/{templateId}/generate", generateRequestSchema, { description: "Generated PDF" }],
] as const;

const requestRoutes = [
  [`/templates/by-table/${tablePublicId}/preview-draft`, draftBody],
  [`/templates/by-table/${tablePublicId}/preview-data-draft`, draftBody],
  [`/templates/${templatePublicId}/preview-draft`, draftBody],
  [`/templates/${templatePublicId}/preview-data-draft`, draftBody],
  [`/templates/${templatePublicId}/preview`, recordBody],
  [`/templates/${templatePublicId}/preview-pdf`, recordBody],
  [`/templates/${templatePublicId}/generate`, generateBody],
] as const;

const expectForbidden = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(forbiddenResponse);
};

const expectPdf = async (response: Response, disposition: string, extraHeaders: Record<string, string> = {}) => {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-disposition")).toBe(disposition);
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const [name, value] of Object.entries(extraHeaders)) expect(response.headers.get(name)).toBe(value);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdfBytes);
};

describe("document render routes", () => {
  beforeEach(() => {
    spyOn(publicResources, "resolvePublicId").mockImplementation(publicResourceMocks.resolvePublicId);
    spyOn(publicResources, "resolvePublicIds").mockImplementation(publicResourceMocks.resolvePublicIds);
    spyOn(publicResources, "projectPublicIds").mockImplementation(publicResourceMocks.projectPublicIds);
    baseLevel = "admin";
    currentTable = table;
    currentTemplate = template;
    currentRecord = record;
    liveResult = { ok: true, data: { source: "compiled source", columns, rows: queryRows, data: liveData } };
    metadataResult = { ok: true, data: { data: enrichedData } };
    htmlResult = { ok: true, data: "<p>Rendered invoice</p>" };
    previewPdfResult = { ok: true, pdf: { pdf: pdfBytes } };
    createResult = { ok: true, data: document };
    permissionChecks = [];
    liveInputs = [];
    metadataInputs = [];
    htmlInputs = [];
    previewPdfInputs = [];
    createInput = undefined;
    callOrder = [];

    spyOn(gridsService.table, "get").mockImplementation(async (id) => (id === tableId ? currentTable : null) as never);
    spyOn(gridsService.record, "get").mockImplementation(
      async (requestedTableId, requestedRecordId) =>
        (requestedTableId === tableId && requestedRecordId === recordId ? currentRecord : null) as never,
    );
    spyOn(gridsService.field, "listByTable").mockImplementation(async () => fields as never);
    spyOn(gridsService.document, "getTemplateByShortId").mockImplementation(
      async (id) => (id === templatePublicId ? currentTemplate : null) as never,
    );
    spyOn(gridsService.document, "buildTemplateAppData").mockImplementation(async () => ({ name: "Grids" }) as never);
    spyOn(gridsService.document, "buildLiveRenderData").mockImplementation(async (input) => {
      callOrder.push("live-data");
      liveInputs.push(input);
      return liveResult as never;
    });
    spyOn(gridsService.document, "buildDocumentRenderData").mockImplementation(async (input) => {
      callOrder.push("metadata");
      metadataInputs.push(input);
      return metadataResult as never;
    });
    spyOn(gridsService.document, "renderHtml").mockImplementation(async (...input) => {
      callOrder.push("html");
      htmlInputs.push(input);
      return htmlResult as never;
    });
    spyOn(gridsService.document, "renderPdfPreview").mockImplementation(async (...input) => {
      callOrder.push("preview-pdf");
      previewPdfInputs.push(input);
      return previewPdfResult as never;
    });
    spyOn(gridsService.document, "renderProfileInput").mockImplementation(
      async () =>
        ({
          ok: true,
          data: { title: "Invoice", net: "100.00", tax: "19.00" },
        }) as never,
    );
    spyOn(gridsService.document, "preview").mockImplementation(
      async () =>
        ({
          ok: true,
          data: [{ key: "pdf", filename: "PREVIEW.pdf", mediaType: "application/pdf", bytes: pdfBytes, sha256: "a".repeat(64) }],
        }) as never,
    );
    spyOn(gridsService.document, "createDocumentForRecord").mockImplementation(async (input) => {
      callOrder.push("create");
      createInput = input;
      return createResult as never;
    });
    spyOn(gridsService.document, "getDocumentArtifact").mockImplementation(async () => {
      const storedDocument = createResult.ok ? createResult.data : document;
      return {
        ok: true,
        data: { bytes: pdfBytes, ...storedDocument.artifacts[0]! },
      } as never;
    });
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => baseLevel);
    spyOn(gridsService.permission, "hasAtLeast").mockImplementation((actual, expected) => {
      permissionChecks.push(expected);
      const rank = { none: 0, read: 1, write: 2, admin: 3 };
      return rank[actual] >= rank[expected];
    });
  });

  afterEach(() => mock.restore());

  test("publishes all render operations in the generated OpenAPI spec", async () => {
    const spec = await generateSpecs(app());
    const paths = spec.paths as Record<
      string,
      Record<string, { requestBody?: { content?: Record<string, { schema?: unknown }> }; responses?: Record<string, unknown> }>
    >;

    for (const [suffix, requestSchema, successResponse] of renderRoutes) {
      const operation = paths[`/documents${suffix}`]?.post;
      expect(operation?.requestBody?.content?.["application/json"]?.schema).toEqual(requestSchema);
      if ("content" in successResponse) {
        const actual = operation?.responses?.["200"] as {
          description?: string;
          content?: { "application/json"?: { schema?: Record<string, unknown> } };
        };
        const schema = actual.content?.["application/json"]?.schema as {
          additionalProperties?: boolean;
          properties?: { data?: { additionalProperties?: boolean; properties?: { record?: { properties?: { id?: unknown } } } } };
        };
        expect(actual.description).toBe(successResponse.description);
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties?.data?.additionalProperties).toBe(false);
        expect(schema.properties?.data?.properties?.record?.properties?.id).toEqual(publicIdOpenApiSchema);
        expect(JSON.stringify(schema)).not.toContain("shortId");
      } else {
        expect(operation?.responses?.["200"]).toEqual(successResponse);
      }
      expect(operation?.responses?.["403"]).toEqual(forbiddenOpenApiResponse);
    }
  });

  for (const [suffix, body] of requestRoutes) {
    test(`parent auth protects POST ${suffix}`, async () => {
      const response = await deniedApp().request(path(suffix), postJson(body));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Authentication required" });
    });
  }

  for (const [suffix, body] of requestRoutes.slice(0, 2)) {
    test(`POST ${suffix} returns the exact table 404 contract`, async () => {
      currentTable = null;
      const response = await app().request(path(suffix), postJson(body));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Table not found", phase: "data" });
    });
  }

  for (const [suffix, body] of requestRoutes.slice(2)) {
    test(`POST ${suffix} returns the exact template 404 contract`, async () => {
      currentTemplate = null;
      const response = await app().request(path(suffix), postJson(body));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(
        suffix.endsWith("preview-draft") || suffix.endsWith("preview-data-draft")
          ? { message: "Document template not found", phase: "data" }
          : { message: "Document template not found" },
      );
    });
  }

  for (const [suffix, body] of requestRoutes.slice(0, 2)) {
    test(`POST ${suffix} requires base admin`, async () => {
      baseLevel = "write";
      await expectForbidden(await app().request(path(suffix), postJson(body)));
    });
  }

  for (const [suffix, body] of requestRoutes.slice(2, 5)) {
    test(`POST ${suffix} requires base admin`, async () => {
      baseLevel = "write";
      await expectForbidden(await app().request(path(suffix), postJson(body)));
    });
  }

  test("saved PDF preview requires base write", async () => {
    baseLevel = "read";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}/preview-pdf`), postJson(recordBody)));
  });

  test("generate requires base write", async () => {
    baseLevel = "read";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}/generate`), postJson(generateBody)));
    expect(callOrder).toEqual([]);
  });

  test("renders a by-table draft PDF with base table admin and inline preview headers", async () => {
    const response = await app().request(path(`/templates/by-table/${tablePublicId}/preview-draft`), postJson(draftBody));

    await expectPdf(response, `inline; filename="preview.pdf"; filename*=UTF-8''preview.pdf`);
    expect(callOrder).toEqual(["live-data", "metadata", "preview-pdf"]);
    expect(previewPdfInputs[0]).toEqual([
      {
        id: undefined,
        shortId: undefined,
        name: undefined,
        source: `from table {${tablePublicId}}`,
        renderer: {
          kind: "html",
          body: "<p>Draft</p>",
          header: "<header>Draft</header>",
          numberTemplate: "{{ template.id }}-{{ document.id }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      enrichedData,
      "preview.html",
      undefined,
      "en",
    ]);
  });

  test("renders by-table draft preview data with the live source and enriched data", async () => {
    const response = await app().request(path(`/templates/by-table/${tablePublicId}/preview-data-draft`), postJson(draftBody));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ html: "<p>Rendered invoice</p>", source: "compiled source", data: publicEnrichedData });
    expectPublicPreviewData(body.data);
    expect(callOrder).toEqual(["live-data", "metadata", "html"]);
  });

  test("renders a saved-template draft PDF with template admin and saved metadata defaults", async () => {
    const response = await app().request(path(`/templates/${templatePublicId}/preview-draft`), postJson(draftBody));

    await expectPdf(response, `inline; filename="preview.pdf"; filename*=UTF-8''preview.pdf`);
    expect(previewPdfInputs[0]).toEqual([
      {
        id: templateId,
        shortId: template.shortId,
        name: template.name,
        source: `from table {${tablePublicId}}`,
        renderer: {
          kind: "html",
          body: "<p>Draft</p>",
          header: "<header>Draft</header>",
          numberTemplate: "{{ template.id }}-{{ document.id }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      enrichedData,
      "preview.html",
      undefined,
      "en",
    ]);
  });

  test("renders saved-template draft preview data with template admin", async () => {
    const response = await app().request(path(`/templates/${templatePublicId}/preview-data-draft`), postJson(draftBody));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ html: "<p>Rendered invoice</p>", source: "compiled source", data: publicEnrichedData });
    expectPublicPreviewData(body.data);
    expect(htmlInputs[0]?.[0]).toEqual(
      expect.objectContaining({
        id: templateId,
        source: `from table {${tablePublicId}}`,
        renderer: expect.objectContaining({ kind: "html", body: "<p>Draft</p>" }),
      }),
    );
  });

  test("renders a saved HTML preview with live date data and template admin", async () => {
    const response = await app().request(path(`/templates/${templatePublicId}/preview`), postJson(recordBody));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ html: "<p>Rendered invoice</p>", source: "compiled source", data: publicEnrichedData });
    expectPublicPreviewData(body.data);
    expect(liveInputs[0]).toEqual(expect.objectContaining({ template, table, record, dateConfig, createdAt: expect.any(Date) }));
    expect(metadataInputs[0]).toEqual(expect.objectContaining({ template, renderData: liveData, dateConfig, createdAt: expect.any(Date) }));
  });

  test("keeps the saved preview contract for a profiled template", async () => {
    currentTemplate = profileTemplate;

    const response = await app().request(path(`/templates/${templatePublicId}/preview`), postJson(recordBody));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ html: "", source: "compiled source", data: publicEnrichedData });
    expectPublicPreviewData(body.data);
    expect(htmlInputs).toEqual([]);
  });

  test("renders a saved PDF preview with template write and exact inline headers", async () => {
    baseLevel = "write";
    const response = await app().request(path(`/templates/${templatePublicId}/preview-pdf`), postJson(recordBody));

    await expectPdf(response, `inline; filename="Invoice July.pdf"; filename*=UTF-8''Invoice%20July.pdf`);
    expect(previewPdfInputs[0]).toEqual([template, enrichedData, `${templatePublicId}-preview.html`, undefined, "en"]);
  });

  test("requires base admin for a disabled saved PDF preview", async () => {
    currentTemplate = disabledTemplate;
    baseLevel = "write";

    await expectForbidden(await app().request(path(`/templates/${templatePublicId}/preview-pdf`), postJson(recordBody)));
    expect(callOrder).toEqual([]);

    baseLevel = "admin";
    const response = await app().request(path(`/templates/${templatePublicId}/preview-pdf`), postJson(recordBody));
    expect(response.status).toBe(200);
  });

  test("authorizes disabled-template retries and lets the issuance owner decide replay or rejection", async () => {
    currentTemplate = disabledTemplate;
    baseLevel = "write";
    createResult = { ok: false, error: { status: 400, message: "Document template is disabled" } };
    const response = await app().request(path(`/templates/${templatePublicId}/generate`), postJson(generateBody));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Document template is disabled" });
    expect(permissionChecks.length).toBeGreaterThan(0);
    expect(callOrder).toEqual(["create"]);
  });

  test("issues an immutable Document with actor and idempotency inputs", async () => {
    baseLevel = "write";
    const response = await app().request(path(`/templates/${templatePublicId}/generate`), postJson(generateBody));

    await expectPdf(response, `attachment; filename="Invoice July.pdf"; filename*=UTF-8''Invoice%20July.pdf`, {
      "x-grids-document-id": documentPublicId,
      "x-grids-document-number": document.documentNumber,
      "x-grids-document-filename": "Invoice%20July.pdf",
    });
    expect(callOrder).toEqual(["create"]);
    const { canReadTable, viewer, ...params } = createInput as {
      template: typeof template;
      table: typeof table;
      recordId: string;
      actor: { kind: "user"; userId: string };
      idempotencyKey: string;
      dateConfig: typeof dateConfig;
      filename: string;
      tags: string[];
      viewer: unknown;
      canReadTable: (target: { baseId: string; tableId: string }) => Promise<boolean>;
    };
    expect(params).toEqual({
      template,
      table,
      recordId,
      actor: { kind: "user", userId },
      idempotencyKey: "invoice-july-v1",
      dateConfig,
      filename: "Custom invoice.pdf",
      tags: ["finance", "july"],
    });
    expect(viewer).toMatchObject({ userId });
    expect(await canReadTable({ baseId, tableId })).toBe(true);
  });

  test("generates a profiled template through the same record-bound endpoint", async () => {
    currentTemplate = profileTemplate;
    const renderedDocument = {
      ...document,
      documentNumber: "STAT-0001",
      filename: "STAT-0001.pdf",
      profile: { id: "test.statement", version: 1 },
      validationStatus: "valid" as const,
      artifacts: [{ ...document.artifacts[0]!, filename: "STAT-0001.pdf" }],
    };
    createResult = { ok: true, data: renderedDocument };
    const response = await app().request(
      path(`/templates/${templatePublicId}/generate`),
      postJson({ recordId: recordPublicId, tags: ["invoice"], idempotencyKey: "profile-record-v1" }),
    );

    await expectPdf(response, `attachment; filename="STAT-0001.pdf"; filename*=UTF-8''STAT-0001.pdf`, {
      "X-Grids-Document-Id": documentPublicId,
      "X-Grids-Document-Number": "STAT-0001",
    });
    expect(createInput).toEqual({
      template: profileTemplate,
      table,
      recordId,
      actor: { kind: "user", userId },
      idempotencyKey: "profile-record-v1",
      canReadTable: expect.any(Function),
      viewer: expect.any(Object),
      dateConfig,
      filename: undefined,
      tags: ["invoice"],
    });
  });

  test("does not generate without base write access", async () => {
    baseLevel = "read";

    const response = await app().request(path(`/templates/${templatePublicId}/generate`), postJson(generateBody));

    expect(response.status).toBe(403);
    expect(callOrder).toEqual([]);
  });

  for (const [suffix, body, failureStatus, expectedStatus, expectedBody] of [
    [`/templates/by-table/${tablePublicId}/preview-draft`, draftBody, 400, 400, { message: "Live render data failed", phase: "source" }],
    [
      `/templates/by-table/${tablePublicId}/preview-data-draft`,
      draftBody,
      400,
      400,
      { message: "Live render data failed", phase: "source" },
    ],
    [`/templates/${templatePublicId}/preview-draft`, draftBody, 400, 400, { message: "Live render data failed", phase: "source" }],
    [`/templates/${templatePublicId}/preview-data-draft`, draftBody, 400, 400, { message: "Live render data failed", phase: "source" }],
    [`/templates/${templatePublicId}/preview`, recordBody, 500, 500, { message: "Live render data failed" }],
    [`/templates/${templatePublicId}/preview-pdf`, recordBody, 500, 500, { message: "Live render data failed" }],
  ] as const) {
    test(`POST ${suffix} stops after a liveRenderData failure`, async () => {
      liveResult = { ok: false, error: { message: "Live render data failed", status: failureStatus } };

      const response = await app().request(path(suffix), postJson(body));

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual(expectedBody);
      expect(callOrder).toEqual(["live-data"]);
    });
  }

  test("forwards owner-local generation failures without reading an artifact", async () => {
    createResult = { ok: false, error: { message: "Record changed while the Document was frozen", status: 400 } };

    const response = await app().request(path(`/templates/${templatePublicId}/generate`), postJson(generateBody));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Record changed while the Document was frozen" });
    expect(callOrder).toEqual(["create"]);
  });

  for (const [suffix, body] of [
    [`/templates/by-table/${tablePublicId}/preview-draft`, draftBody],
    [`/templates/by-table/${tablePublicId}/preview-data-draft`, draftBody],
    [`/templates/${templatePublicId}/preview-draft`, draftBody],
    [`/templates/${templatePublicId}/preview-data-draft`, draftBody],
    [`/templates/${templatePublicId}/preview`, recordBody],
    [`/templates/${templatePublicId}/preview-pdf`, recordBody],
  ] as const) {
    test(`POST ${suffix} stops after an addDraftDocumentMetadata failure`, async () => {
      metadataResult = { ok: false, error: { message: "Document metadata failed", status: 500 } };

      const response = await app().request(path(suffix), postJson(body));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "Document metadata failed", phase: "document" });
      expect(callOrder).toEqual(["live-data", "metadata"]);
    });
  }

  for (const [suffix, body, status, expectedBody] of [
    [`/templates/by-table/${tablePublicId}/preview-data-draft`, draftBody, 400, { message: "HTML render failed", phase: "html" }],
    [`/templates/${templatePublicId}/preview-data-draft`, draftBody, 500, { message: "HTML render failed", phase: "html" }],
    [`/templates/${templatePublicId}/preview`, recordBody, 500, { message: "HTML render failed" }],
  ] as const) {
    test(`POST ${suffix} returns the exact HTML render failure`, async () => {
      htmlResult = { ok: false, error: { message: "HTML render failed", status } };

      const response = await app().request(path(suffix), postJson(body));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(expectedBody);
      expect(callOrder).toEqual(["live-data", "metadata", "html"]);
    });
  }

  for (const [suffix, body] of [
    [`/templates/by-table/${tablePublicId}/preview-draft`, draftBody],
    [`/templates/${templatePublicId}/preview-draft`, draftBody],
    [`/templates/${templatePublicId}/preview-pdf`, recordBody],
  ] as const) {
    for (const [serviceStatus, expectedStatus] of [
      [400, 400],
      [502, 502],
      [500, 500],
    ] as const) {
      test(`POST ${suffix} maps PDF status ${serviceStatus} to ${expectedStatus}`, async () => {
        previewPdfResult = {
          ok: false,
          error: { message: "PDF render failed", phase: "pdf", code: "PDF_FAILED", status: serviceStatus },
        };

        const response = await app().request(path(suffix), postJson(body));

        expect(response.status).toBe(expectedStatus);
        expect(await response.json()).toEqual({ message: "PDF render failed", phase: "pdf", code: "PDF_FAILED" });
        expect(callOrder).toEqual(["live-data", "metadata", "preview-pdf"]);
      });
    }
  }

  for (const status of [400, 502, 500] as const) {
    test(`generate forwards owner-local creation status ${status}`, async () => {
      createResult = { ok: false, error: { message: "Stored PDF render failed", status } };

      const response = await app().request(path(`/templates/${templatePublicId}/generate`), postJson(generateBody));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: "Stored PDF render failed" });
      expect(callOrder).toEqual(["create"]);
    });
  }
});
