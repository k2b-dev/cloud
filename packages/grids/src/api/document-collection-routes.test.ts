import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext, PermissionLevel } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { gridsService } from "../service";
import { createDocumentsApi } from "./documents";
import { projectDocuments } from "./documents-api-shared";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const otherTemplateId = "44444444-4444-4444-8444-444444444444";
const recordId = "55555555-5555-4555-8555-555555555555";
const documentId = "66666666-6666-4666-8666-666666666666";
const snapshotId = "77777777-7777-4777-8777-777777777777";
const userId = "88888888-8888-4888-8888-888888888888";
const basePublicId = "BASE01";
const tablePublicId = "TABL01";
const templatePublicId = "TMPL01";
const otherTemplatePublicId = "TMPL02";
const recordPublicId = "RECD01";
const documentPublicId = "DOC001";
const otherDocumentPublicId = "DOC002";
const snapshotPublicId = "SNAP01";
const otherDocumentId = "99999999-9999-4999-8999-999999999999";

const publicToInternal = new Map([
  [basePublicId, baseId],
  [tablePublicId, tableId],
  [templatePublicId, templateId],
  [otherTemplatePublicId, otherTemplateId],
  [recordPublicId, recordId],
  [documentPublicId, documentId],
  [otherDocumentPublicId, otherDocumentId],
  [snapshotPublicId, snapshotId],
]);
const internalToPublic = new Map([...publicToInternal].map(([publicId, internalId]) => [internalId, publicId]));
mock.module("../service/public-resources", () => ({
  resolvePublicId: async (_type: string, publicId: string) => publicToInternal.get(publicId) ?? null,
  resolvePublicIds: async (_type: string, publicIds: string[]) =>
    new Map(publicIds.flatMap((publicId) => (publicToInternal.has(publicId) ? [[publicId, publicToInternal.get(publicId)!]] : []))),
  projectPublicIds: async (_type: string, internalIds: string[]) =>
    new Map(
      internalIds.flatMap((internalId) => (internalToPublic.has(internalId) ? [[internalId, internalToPublic.get(internalId)!]] : [])),
    ),
}));
const validCursor = Buffer.from(JSON.stringify({ createdAt: "2026-07-11T08:00:00.000Z", id: documentId }), "utf8").toString("base64url");

const user: User = {
  id: userId,
  uid: "document-document-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Document",
  sn: "Record",
  displayName: "Document Record",
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

const table = { id: tableId, baseId };
const template = { id: templateId, shortId: templatePublicId, tableId };
type DocumentFixture = {
  id: string;
  shortId: string;
  templateId: string;
  workflowRunId: string | null;
  snapshotId: string;
  baseId: string;
  tableId: string;
  recordId: string;
  documentNumber: string;
  filename: string;
  tags: string[];
  templateSnapshot: { html: string };
  renderData: { snapshot: { root: { id: string } } };
  artifacts: Array<{
    key: string;
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }>;
  profile: { id: string; version: number } | null;
  validationStatus: "valid" | "warning" | null;
  createdBy: string | null;
  createdAt: string;
};

const document: DocumentFixture = {
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
  templateSnapshot: { html: "<p>Stored</p>" },
  renderData: { snapshot: { root: { id: recordId } } },
  artifacts: [
    {
      key: "pdf",
      fileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      filename: "Invoice July.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      sha256: "a".repeat(64),
    },
  ],
  profile: null,
  validationStatus: null,
  createdBy: userId,
  createdAt: "2026-07-11T08:00:00.000Z",
};
const otherTemplateDocument: DocumentFixture = {
  ...document,
  id: otherDocumentId,
  shortId: otherDocumentPublicId,
  templateId: otherTemplateId,
};

const summarizeDocument = (row: DocumentFixture) => ({
  id: row.id,
  shortId: row.shortId,
  templateId: row.templateId,
  workflowRunId: row.workflowRunId,
  snapshotId: row.snapshotId,
  baseId: row.baseId,
  tableId: row.tableId,
  recordId: row.recordId,
  documentNumber: row.documentNumber,
  filename: row.filename,
  tags: row.tags,
  artifacts: row.artifacts,
  profile: row.profile,
  validationStatus: row.validationStatus,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});
const publicDocument = (row: DocumentFixture) => ({
  id: row.shortId,
  baseId: basePublicId,
  tableId: tablePublicId,
  recordId: recordPublicId,
  templateId: row.templateId === templateId ? templatePublicId : otherTemplatePublicId,
  number: row.documentNumber,
  filename: row.filename,
  createdAt: row.createdAt,
  tags: row.tags,
  createdBy: row.createdBy,
  renderer: row.profile ? { kind: "profile", ...row.profile } : { kind: "html" },
  validationStatus: row.validationStatus,
  artifacts: row.artifacts.map(({ fileId: _fileId, ...artifact }) => artifact),
});

const forbiddenResponse = {
  message: "You do not have permission to access this resource.",
  code: "FORBIDDEN",
};

let tableLevel: PermissionLevel = "read";
let currentTemplate: typeof template | null = template;
let currentTable: typeof table | null = table;
let currentDocument: DocumentFixture | null = document;
let listTemplateInput: unknown;
let browseTemplateInput: unknown;
let listRecordInput: unknown;
let listBaseInput: unknown;
let artifactInput: unknown;
let artifactResult:
  | {
      ok: true;
      data: { bytes: Uint8Array; key: string; fileId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string };
    }
  | { ok: false; error: { code: string; message: string; status: 400 | 404 | 500 | 502 } };

const authenticated: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};

const app = () => new Hono<AuthContext>().route("/documents", createDocumentsApi({ requireAuthenticated: authenticated }));
const denyAuthentication: MiddlewareHandler<AuthContext> = async (c) => c.json({ message: "Authentication required" }, 401);
const deniedApp = () => new Hono<AuthContext>().route("/documents", createDocumentsApi({ requireAuthenticated: denyAuthentication }));
const path = (suffix: string) => `/documents${suffix}`;
const expectForbidden = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(forbiddenResponse);
};

describe("document routes", () => {
  beforeEach(() => {
    tableLevel = "read";
    currentTemplate = template;
    currentTable = table;
    currentDocument = document;
    listTemplateInput = undefined;
    browseTemplateInput = undefined;
    listRecordInput = undefined;
    listBaseInput = undefined;
    artifactInput = undefined;
    artifactResult = { ok: true, data: { bytes: new Uint8Array([37, 80, 68, 70]), ...document.artifacts[0]! } };

    spyOn(gridsService.table, "get").mockImplementation(async (id) => (id === tableId ? currentTable : null) as never);
    spyOn(gridsService.document, "getTemplateByShortId").mockImplementation(
      async (id) => (id === templatePublicId ? currentTemplate : null) as never,
    );
    spyOn(gridsService.document, "listDocumentsForTemplate").mockImplementation(async (input) => {
      listTemplateInput = input;
      return {
        items: [summarizeDocument(document)],
        hasMore: true,
        nextCursor: "next-list-cursor",
      } as never;
    });
    spyOn(gridsService.document, "browseDocumentsForTemplate").mockImplementation(async (input) => {
      browseTemplateInput = input;
      return {
        path: ["2026", "07"],
        folders: [{ kind: "month", key: "08", label: "August", path: ["2026", "08"], count: 2 }],
        items: [summarizeDocument(document)],
        hasMore: true,
        nextCursor: "next-browse-cursor",
      } as never;
    });
    spyOn(gridsService.document, "listForRecord").mockImplementation(async (input) => {
      listRecordInput = input;
      return {
        items: (input.templateId ? [document] : [document, otherTemplateDocument]).map(summarizeDocument),
        hasMore: true,
        nextCursor: "next-record-cursor",
      } as never;
    });
    spyOn(gridsService.document, "listForBase").mockImplementation(async (input) => {
      listBaseInput = input;
      return { items: [summarizeDocument(document)], hasMore: true, nextCursor: "next-base-cursor" } as never;
    });
    spyOn(gridsService.document, "getDocument").mockImplementation(async (id) => (id === documentId ? currentDocument : null) as never);
    spyOn(gridsService.document, "getDocumentArtifact").mockImplementation(async (documentId, key) => {
      artifactInput = { documentId, key };
      return key === "pdf"
        ? (artifactResult as never)
        : ({ ok: false, error: { code: "NOT_FOUND", message: "Document artifact not found", status: 404 } } as never);
    });
    spyOn(gridsService.document, "summarizeDocument").mockImplementation(summarizeDocument as never);
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => tableLevel);
  });

  afterEach(() => mock.restore());

  test("publishes every document operation in the generated OpenAPI spec", async () => {
    const spec = await generateSpecs(app());
    const paths = spec.paths as Record<string, Record<string, unknown>>;

    for (const [method, operationPath] of [
      ["get", "/documents/by-template/{templateId}"],
      ["get", "/documents/by-template/{templateId}/browse"],
      ["get", "/documents/by-template/{templateId}/{recordId}"],
      ["get", "/documents/by-record/{tableId}/{recordId}"],
      ["get", "/documents/{documentId}"],
      ["get", "/documents/{documentId}/artifacts/{artifactKey}"],
      ["get", "/documents/{documentId}/download"],
    ] as const) {
      expect(paths[operationPath]?.[method]).toBeDefined();
    }
  });

  test("fails closed when a required internal binding has no public ID", async () => {
    internalToPublic.delete(templateId);
    try {
      await expect(projectDocuments([summarizeDocument(document) as never])).rejects.toThrow(
        "Grids could not project a public document template id.",
      );
    } finally {
      internalToPublic.set(templateId, templatePublicId);
    }
  });

  for (const [method, suffix] of [
    ["GET", `/by-template/${templatePublicId}`],
    ["GET", `/by-template/${templatePublicId}/browse`],
    ["GET", `/by-template/${templatePublicId}/${recordPublicId}`],
    ["GET", `/by-record/${tablePublicId}/${recordPublicId}`],
    ["GET", `/by-base/${basePublicId}`],
    ["GET", "/renderers"],
    ["GET", `/${documentPublicId}`],
    ["GET", `/${documentPublicId}/artifacts/pdf`],
    ["GET", `/${documentPublicId}/download`],
  ] as const) {
    test(`parent auth protects ${method} ${suffix}`, async () => {
      const response = await deniedApp().request(path(suffix), { method });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Authentication required" });
    });
  }

  describe("GET /by-base/:baseId", () => {
    test("requires base read permission before listing Documents", async () => {
      tableLevel = "none";

      await expectForbidden(await app().request(path(`/by-base/${basePublicId}`)));
      expect(listBaseInput).toBeUndefined();
    });

    test("returns the same cursor collection and PublicDocument shape", async () => {
      const response = await app().request(path(`/by-base/${basePublicId}?limit=2&cursor=${validCursor}`));

      expect(response.status).toBe(200);
      expect(listBaseInput).toEqual({ baseId, limit: 2, cursor: validCursor });
      expect(await response.json()).toEqual({
        items: [publicDocument(document)],
        cursor: "next-base-cursor",
        hasMore: true,
      });
    });
  });

  describe("GET /by-template/:templateId", () => {
    test("returns the exact 404 contract", async () => {
      currentTemplate = null;
      const response = await app().request(path(`/by-template/${templatePublicId}`));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Document template not found" });
    });

    test("requires base read permission", async () => {
      tableLevel = "none";
      await expectForbidden(await app().request(path(`/by-template/${templatePublicId}`)));
    });

    test("forwards pagination and maps summaries", async () => {
      const response = await app().request(
        path(`/by-template/${templatePublicId}?q=invoice&tags=finance%2Cpaid&limit=2&cursor=${validCursor}`),
      );

      expect(response.status).toBe(200);
      expect(listTemplateInput).toEqual({
        templateId,
        q: "invoice",
        tags: ["finance", "paid"],
        limit: 2,
        cursor: validCursor,
      });
      expect(await response.json()).toEqual({
        items: [publicDocument(document)],
        cursor: "next-list-cursor",
        hasMore: true,
      });
    });

    test("rejects an invalid cursor before querying documents", async () => {
      const response = await app().request(path(`/by-template/${templatePublicId}?cursor=not-a-cursor`));

      expect(response.status).toBe(400);
      expect(listTemplateInput).toBeUndefined();
    });

    test("bounds every public Document page to the shared limit", async () => {
      const accepted = await app().request(path(`/by-template/${templatePublicId}?limit=100`));
      expect(accepted.status).toBe(200);
      expect(listTemplateInput).toMatchObject({ limit: 100 });

      listTemplateInput = undefined;
      const rejected = await app().request(path(`/by-template/${templatePublicId}?limit=101`));
      expect(rejected.status).toBe(400);
      expect(listTemplateInput).toBeUndefined();
    });

    test("forwards stable list defaults", async () => {
      const response = await app().request(path(`/by-template/${templatePublicId}`));

      expect(response.status).toBe(200);
      expect(listTemplateInput).toEqual({
        templateId,
        q: "",
        tags: [],
        limit: 50,
        cursor: null,
      });
    });
  });

  describe("GET /by-template/:templateId/browse", () => {
    test("returns the exact 404 contract", async () => {
      currentTemplate = null;
      const response = await app().request(path(`/by-template/${templatePublicId}/browse`));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Document template not found" });
    });

    test("requires base read permission", async () => {
      tableLevel = "none";
      await expectForbidden(await app().request(path(`/by-template/${templatePublicId}/browse`)));
    });

    test("keeps the specific route ahead of the record route and forwards browse query", async () => {
      const response = await app().request(
        path(
          `/by-template/${templatePublicId}/browse?q=invoice&tags=finance%2Cpaid&limit=2&cursor=${validCursor}&path=2026%2F07&mode=folders`,
        ),
        { headers: { cookie: "cloud.timezone=Europe%2FBerlin" } },
      );

      expect(response.status).toBe(200);
      expect(browseTemplateInput).toEqual({
        templateId,
        q: "invoice",
        tags: ["finance", "paid"],
        limit: 2,
        cursor: validCursor,
        path: ["2026", "07"],
        mode: "folders",
        timeZone: "Europe/Berlin",
      });
      expect(await response.json()).toEqual({
        path: ["2026", "07"],
        folders: [{ kind: "month", key: "08", label: "August", path: ["2026", "08"], count: 2 }],
        items: [publicDocument(document)],
        cursor: "next-browse-cursor",
        hasMore: true,
      });
    });

    test("forwards stable browse defaults", async () => {
      const response = await app().request(path(`/by-template/${templatePublicId}/browse`));

      expect(response.status).toBe(200);
      expect(browseTemplateInput).toEqual({
        templateId,
        q: "",
        tags: [],
        limit: 50,
        cursor: null,
        path: [],
        mode: "list",
        timeZone: "UTC",
      });
    });
  });

  describe("GET /by-template/:templateId/:recordId", () => {
    test("returns the exact 404 contract", async () => {
      const response = await app().request(path(`/by-template/${templatePublicId}/not-a-record-id`));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Record not found" });
    });

    test("requires base read permission", async () => {
      tableLevel = "none";
      await expectForbidden(await app().request(path(`/by-template/${templatePublicId}/${recordPublicId}`)));
    });

    test("returns only summaries for the selected template", async () => {
      const response = await app().request(path(`/by-template/${templatePublicId}/${recordPublicId}`));

      expect(response.status).toBe(200);
      expect(listRecordInput).toEqual({
        baseId,
        tableId,
        recordId,
        templateId,
        limit: 50,
        cursor: null,
      });
      expect(await response.json()).toEqual({
        items: [publicDocument(document)],
        cursor: "next-record-cursor",
        hasMore: true,
      });
    });
  });

  describe("GET /by-record/:tableId/:recordId", () => {
    test("returns the exact 404 contract", async () => {
      currentTable = null;
      const response = await app().request(path(`/by-record/${tablePublicId}/${recordPublicId}`));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Table not found" });
    });

    test("requires table read permission", async () => {
      tableLevel = "none";
      await expectForbidden(await app().request(path(`/by-record/${tablePublicId}/${recordPublicId}`)));
    });

    test("returns all document summaries for the record", async () => {
      const response = await app().request(path(`/by-record/${tablePublicId}/${recordPublicId}`));

      expect(response.status).toBe(200);
      expect(listRecordInput).toEqual({ baseId, tableId, recordId, limit: 50, cursor: null });
      expect(await response.json()).toEqual({
        items: [publicDocument(document), publicDocument(otherTemplateDocument)],
        cursor: "next-record-cursor",
        hasMore: true,
      });
    });
  });

  describe("GET /:documentId/download", () => {
    test("returns the exact 404 contract", async () => {
      currentDocument = null;
      const response = await app().request(path(`/${documentPublicId}/download`));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Document not found" });
    });

    test("requires base read permission", async () => {
      tableLevel = "none";
      await expectForbidden(await app().request(path(`/${documentPublicId}/download`)));
      expect(artifactInput).toBeUndefined();
    });

    test("keeps base permissions after the source template is deleted", async () => {
      currentTemplate = null;
      tableLevel = "none";

      await expectForbidden(await app().request(path(`/${documentPublicId}/download`)));
      expect(artifactInput).toBeUndefined();
    });

    test("returns the stored PDF artifact and download headers", async () => {
      const response = await app().request(path(`/${documentPublicId}/download`));

      expect(response.status).toBe(200);
      expect(artifactInput).toEqual({ documentId: documentId, key: "pdf" });
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="Invoice July.pdf"; filename*=UTF-8''Invoice%20July.pdf`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-grids-document-id")).toBe(documentPublicId);
      expect(response.headers.get("x-grids-document-number")).toBe("DOC-001");
      expect(response.headers.get("x-grids-document-artifact")).toBe("pdf");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    });

    test("forwards stored-artifact failures without download headers", async () => {
      artifactResult = {
        ok: false,
        error: { code: "INTERNAL", message: "Stored Document artifact is missing", status: 500 },
      };

      const response = await app().request(path(`/${documentPublicId}/download`));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "Stored Document artifact is missing", code: "INTERNAL" });
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("x-grids-document-id")).toBeNull();
    });
  });

  describe("canonical Document detail and artifact routes", () => {
    test("projects a template-generated PDF through the same Document detail shape", async () => {
      const response = await app().request(path(`/${documentPublicId}`));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(publicDocument(document));
    });

    test("downloads the ordinary PDF through the generic exact-artifact route without bypassing permissions", async () => {
      tableLevel = "none";
      await expectForbidden(await app().request(path(`/${documentPublicId}/artifacts/pdf`)));
      expect(artifactInput).toBeUndefined();

      tableLevel = "read";
      const response = await app().request(path(`/${documentPublicId}/artifacts/pdf`));
      expect(response.status).toBe(200);
      expect(artifactInput).toEqual({ documentId: documentId, key: "pdf" });
      expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Invoice%20July.pdf");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    });

    test("does not invent non-PDF artifacts for a template-generated Document", async () => {
      const response = await app().request(path(`/${documentPublicId}/artifacts/structured`));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Document artifact not found", code: "NOT_FOUND" });
    });
  });
});
