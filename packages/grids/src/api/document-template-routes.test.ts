import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext, PermissionLevel } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { gridsService } from "../service";
import * as numberSeriesService from "../service/number-series";
import * as publicResources from "../service/public-resources";
import { createDocumentsApi } from "./documents";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const disabledTemplateId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const excludedRecordId = "66666666-6666-4666-8666-666666666666";
const lookupRecordId = "77777777-7777-4777-8777-777777777777";
const basePublicId = "BASE01";
const tablePublicId = "TABL01";
const templatePublicId = "TMPL01";
const disabledTemplatePublicId = "TMPL02";
const excludedRecordPublicId = "RECD01";
const lookupRecordPublicId = "RECD02";
const numberSeriesId = "88888888-8888-4888-8888-888888888888";
const numberSeriesPublicId = "SER001";

const numberSeries = {
  id: numberSeriesId,
  shortId: numberSeriesPublicId,
  assignment: "creation" as const,
  state: "active" as const,
  currentVersion: 1,
  lastValue: 12,
  preview: null,
  migrationStatus: "native",
  migrationNote: null,
};

const publicToInternal = new Map([
  [basePublicId, baseId],
  [tablePublicId, tableId],
  [templatePublicId, templateId],
  [disabledTemplatePublicId, disabledTemplateId],
  [excludedRecordPublicId, excludedRecordId],
  [lookupRecordPublicId, lookupRecordId],
]);
const internalToPublic = new Map([...publicToInternal].map(([publicId, internalId]) => [internalId, publicId]));
const publicResourceMocks = {
  resolvePublicId: async (_type: string, publicId: string) => publicToInternal.get(publicId) ?? null,
  resolveStoredPublicId: async (_type: string, publicId: string) => publicToInternal.get(publicId) ?? null,
  resolvePublicIds: async (_type: string, publicIds: readonly string[]) =>
    new Map(publicIds.flatMap((publicId) => (publicToInternal.has(publicId) ? [[publicId, publicToInternal.get(publicId)!]] : []))),
  projectPublicIds: async (_type: string, internalIds: readonly string[]) =>
    new Map(
      internalIds.flatMap((internalId) => (internalToPublic.has(internalId) ? [[internalId, internalToPublic.get(internalId)!]] : [])),
    ),
};

const user: User = {
  id: userId,
  uid: "document-template-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Document",
  sn: "Template",
  displayName: "Document Template",
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

const table = {
  id: tableId,
  shortId: tablePublicId,
  baseId,
  name: "Hidden table",
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" as const },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-07-11T08:00:00.000Z",
  updatedAt: "2026-07-11T08:00:00.000Z",
};

const template = {
  id: templateId,
  shortId: templatePublicId,
  tableId,
  name: "Invoice",
  description: "Customer invoice",
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
const disabledTemplate = {
  ...template,
  id: disabledTemplateId,
  shortId: disabledTemplatePublicId,
  name: "Disabled",
  enabled: false,
  position: 1,
};

const summary = (row: typeof template) => ({
  id: row.shortId,
  tableId: tablePublicId,
  name: row.name,
  description: row.description,
  renderer: row.renderer,
  enabled: row.enabled,
  position: row.position,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const publicTemplate = (row: typeof template) => {
  const { shortId, ...value } = row;
  return {
    ...value,
    id: shortId,
    tableId: tablePublicId,
    numberSeries: {
      id: numberSeriesPublicId,
      assignment: "creation",
      state: "active",
      currentVersion: 1,
      lastValue: 12,
      preview: null,
      migrationStatus: "native",
      migrationNote: null,
    },
  };
};

const forbiddenResponse = {
  message: "You do not have permission to access this resource.",
  code: "FORBIDDEN",
};

let baseLevel: PermissionLevel = "admin";
let currentTable: typeof table | null = table;
let currentTemplate: typeof template | null = template;
let tableGetInputs: string[] = [];
let templateGetInputs: string[] = [];
let listInputs: string[] = [];
let createInput: unknown;
let updateInput: unknown;
let reorderInput: unknown;
let removeInput: unknown;
let restoreInput: unknown;
let lookupInput: unknown;

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
const jsonRequest = (method: "POST" | "PATCH", body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const createBody = {
  name: " Invoice ",
  description: "Customer invoice",
  source: ` from table {${tablePublicId}} `,
  renderer: {
    kind: "html",
    body: " <p>{{ record.id }}</p> ",
    numberTemplate: "{{ template.id }}-{{ document.id }}",
    filenameTemplate: "{{ document.number }}.pdf",
  },
  enabled: true,
};
const updateBody = { name: " Updated invoice ", position: 2 };

const expectForbidden = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(forbiddenResponse);
};

describe("document template routes", () => {
  beforeEach(() => {
    spyOn(numberSeriesService, "loadDocumentNumberSeries").mockImplementation(async (ids) => new Map(ids.map((id) => [id, numberSeries])));
    spyOn(publicResources, "resolvePublicId").mockImplementation(publicResourceMocks.resolvePublicId);
    spyOn(publicResources, "resolveStoredPublicId").mockImplementation(publicResourceMocks.resolveStoredPublicId);
    spyOn(publicResources, "resolvePublicIds").mockImplementation(publicResourceMocks.resolvePublicIds);
    spyOn(publicResources, "projectPublicIds").mockImplementation(publicResourceMocks.projectPublicIds);
    baseLevel = "admin";
    currentTable = table;
    currentTemplate = template;
    tableGetInputs = [];
    templateGetInputs = [];
    listInputs = [];
    createInput = undefined;
    updateInput = undefined;
    reorderInput = undefined;
    removeInput = undefined;
    restoreInput = undefined;
    lookupInput = undefined;

    spyOn(gridsService.table, "get").mockImplementation(async (id) => {
      tableGetInputs.push(id);
      return (id === tableId ? currentTable : null) as never;
    });
    spyOn(gridsService.document, "getTemplateByShortId").mockImplementation(async (id) => {
      templateGetInputs.push(id);
      return (id === templatePublicId ? currentTemplate : null) as never;
    });
    spyOn(gridsService.document, "getStoredTemplate").mockImplementation(async (id) => {
      templateGetInputs.push(id);
      return (id === templateId ? currentTemplate : null) as never;
    });
    spyOn(gridsService.document, "listTemplatesForTable").mockImplementation(async (id) => {
      listInputs.push(id);
      return (id === tableId ? [template, disabledTemplate] : []) as never;
    });
    spyOn(gridsService.document, "summarizeTemplate").mockImplementation(summary as never);
    spyOn(gridsService.document, "createTemplate").mockImplementation(async (id, input, actorId) => {
      createInput = { tableId: id, input, actorId };
      return { ok: true, data: template } as never;
    });
    spyOn(gridsService.document, "updateTemplate").mockImplementation(async (id, input, actorId) => {
      updateInput = { templateId: id, input, actorId };
      return { ok: true, data: { ...template, ...(input as object) } } as never;
    });
    spyOn(gridsService.document, "reorderTemplates").mockImplementation(async (id, templateIds, actorId) => {
      reorderInput = { tableId: id, templateIds, actorId };
      return { ok: true, data: undefined };
    });
    spyOn(gridsService.document, "removeTemplate").mockImplementation(async (id, actorId) => {
      removeInput = { templateId: id, actorId };
      return { ok: true, data: undefined };
    });
    spyOn(gridsService.document, "restoreTemplate").mockImplementation(async (id, actorId) => {
      restoreInput = { templateId: id, actorId };
      return { ok: true, data: template } as never;
    });
    spyOn(gridsService.relations, "lookup").mockImplementation(async (input) => {
      lookupInput = input;
      return { items: [{ id: lookupRecordId, label: "Invoice recipient" }] } as never;
    });
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => baseLevel);
  });

  afterEach(() => mock.restore());

  test("publishes all template management operations in the generated OpenAPI spec", async () => {
    const spec = await generateSpecs(app());
    const paths = spec.paths as Record<string, Record<string, { summary?: string; responses?: Record<string, unknown> }>>;

    for (const [method, operationPath, routeSummary, statuses] of [
      ["get", "/documents/templates/by-table/{tableId}", "List document templates for a table", ["200", "403"]],
      ["get", "/documents/templates/by-table/{tableId}/full", "List full document templates for table admins", ["200", "403"]],
      ["post", "/documents/templates/by-table/{tableId}", "Create a document template", ["201", "403"]],
      ["patch", "/documents/templates/by-table/{tableId}/reorder", "Reorder document templates", ["204", "403", "409"]],
      ["get", "/documents/templates/{templateId}", "Get a document template", ["200", "403"]],
      ["patch", "/documents/templates/{templateId}", "Update a document template", ["200", "403"]],
      ["delete", "/documents/templates/{templateId}", "Delete a document template", ["204", "403"]],
      ["post", "/documents/templates/{templateId}/restore", "Restore a soft-deleted document template", ["200", "403", "404"]],
      ["get", "/documents/templates/{templateId}/records/lookup", "Search records for a document template", ["200", "403"]],
    ] as const) {
      const operation = paths[operationPath]?.[method];
      expect(operation?.summary).toBe(routeSummary);
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([...statuses].sort());
    }
  });

  for (const [method, suffix, body] of [
    ["GET", `/templates/by-table/${tablePublicId}`, undefined],
    ["GET", `/templates/by-table/${tablePublicId}/full`, undefined],
    ["POST", `/templates/by-table/${tablePublicId}`, createBody],
    ["PATCH", `/templates/by-table/${tablePublicId}/reorder`, { templateIds: [disabledTemplatePublicId, templatePublicId] }],
    ["GET", `/templates/${templatePublicId}`, undefined],
    ["PATCH", `/templates/${templatePublicId}`, updateBody],
    ["DELETE", `/templates/${templatePublicId}`, undefined],
    ["POST", `/templates/${templatePublicId}/restore`, undefined],
    ["GET", `/templates/${templatePublicId}/records/lookup`, undefined],
  ] as const) {
    test(`parent auth protects ${method} ${suffix}`, async () => {
      const response = await deniedApp().request(
        path(suffix),
        body === undefined ? { method } : jsonRequest(method as "POST" | "PATCH", body),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Authentication required" });
    });
  }

  for (const [method, suffix, body] of [
    ["GET", `/templates/by-table/${tablePublicId}`, undefined],
    ["GET", `/templates/by-table/${tablePublicId}/full`, undefined],
    ["POST", `/templates/by-table/${tablePublicId}`, createBody],
    ["PATCH", `/templates/by-table/${tablePublicId}/reorder`, { templateIds: [disabledTemplatePublicId, templatePublicId] }],
  ] as const) {
    test(`${method} ${suffix} returns the exact table 404 contract`, async () => {
      currentTable = null;
      const response = await app().request(path(suffix), body === undefined ? { method } : jsonRequest(method as "POST", body));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Table not found" });
    });
  }

  for (const [method, suffix, body] of [
    ["GET", `/templates/${templatePublicId}`, undefined],
    ["PATCH", `/templates/${templatePublicId}`, updateBody],
    ["DELETE", `/templates/${templatePublicId}`, undefined],
    ["GET", `/templates/${templatePublicId}/records/lookup`, undefined],
  ] as const) {
    test(`${method} ${suffix} returns the exact template 404 contract`, async () => {
      currentTemplate = null;
      const response = await app().request(path(suffix), body === undefined ? { method } : jsonRequest(method as "PATCH", body));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Document template not found" });
      expect(templateGetInputs).toEqual([templatePublicId]);
    });
  }

  test("lists every template summary through base read access", async () => {
    baseLevel = "read";

    const response = await app().request(path(`/templates/by-table/${tablePublicId}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([summary(template), summary(disabledTemplate)]);
    expect(tableGetInputs).toEqual([tableId]);
    expect(listInputs).toEqual([tableId]);
  });

  test("forwards the requested minimum permission when listing summaries", async () => {
    baseLevel = "read";

    await expectForbidden(await app().request(path(`/templates/by-table/${tablePublicId}?min=write`)));
    expect(listInputs).toEqual([]);
  });

  test("requires base admin and returns every full template", async () => {
    baseLevel = "write";
    await expectForbidden(await app().request(path(`/templates/by-table/${tablePublicId}/full`)));

    baseLevel = "admin";
    const response = await app().request(path(`/templates/by-table/${tablePublicId}/full`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([publicTemplate(template), publicTemplate(disabledTemplate)]);
    expect(listInputs).toEqual([tableId]);
  });

  test("creates a template only with base admin and forwards input plus audit actor", async () => {
    baseLevel = "write";
    await expectForbidden(await app().request(path(`/templates/by-table/${tablePublicId}`), jsonRequest("POST", createBody)));
    expect(createInput).toBeUndefined();

    baseLevel = "admin";
    const response = await app().request(path(`/templates/by-table/${tablePublicId}`), jsonRequest("POST", createBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(publicTemplate(template));
    expect(createInput).toEqual({
      tableId,
      input: {
        name: " Invoice ",
        description: "Customer invoice",
        source: `from table {${tablePublicId}}`,
        renderer: {
          kind: "html",
          body: "<p>{{ record.id }}</p>",
          numberTemplate: "{{ template.id }}-{{ document.id }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
        enabled: true,
      },
      actorId: userId,
    });
  });

  test("gets a full template with base admin access", async () => {
    baseLevel = "none";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}`)));

    baseLevel = "admin";
    const response = await app().request(path(`/templates/${templatePublicId}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicTemplate(template));
    expect(templateGetInputs).toEqual([templatePublicId, templatePublicId]);
    expect(tableGetInputs).toEqual([tableId, tableId]);
  });

  test("updates a template with base admin access and forwards input plus audit actor", async () => {
    baseLevel = "write";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}`), jsonRequest("PATCH", updateBody)));
    expect(updateInput).toBeUndefined();

    baseLevel = "admin";
    const response = await app().request(path(`/templates/${templatePublicId}`), jsonRequest("PATCH", updateBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicTemplate({ ...template, name: " Updated invoice ", position: 2 }));
    expect(updateInput).toEqual({ templateId, input: updateBody, actorId: userId });
  });

  test("reorders all templates atomically with base admin access", async () => {
    const body = { templateIds: [disabledTemplatePublicId, templatePublicId] };
    baseLevel = "write";
    await expectForbidden(await app().request(path(`/templates/by-table/${tablePublicId}/reorder`), jsonRequest("PATCH", body)));
    expect(reorderInput).toBeUndefined();

    baseLevel = "admin";
    const response = await app().request(path(`/templates/by-table/${tablePublicId}/reorder`), jsonRequest("PATCH", body));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(reorderInput).toEqual({ tableId, templateIds: [disabledTemplateId, templateId], actorId: userId });
  });

  test("deletes a template with base admin access and forwards the audit actor", async () => {
    baseLevel = "write";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}`), { method: "DELETE" }));
    expect(removeInput).toBeUndefined();

    baseLevel = "admin";
    const response = await app().request(path(`/templates/${templatePublicId}`), { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(removeInput).toEqual({ templateId, actorId: userId });
  });

  test("restores a template with base admin access and forwards the audit actor", async () => {
    baseLevel = "write";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}/restore`), { method: "POST" }));
    expect(restoreInput).toBeUndefined();

    baseLevel = "admin";
    const response = await app().request(path(`/templates/${templatePublicId}/restore`), { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicTemplate(template));
    expect(restoreInput).toEqual({ templateId, actorId: userId });
  });

  test("looks up records with base write access and forwards the normalized query", async () => {
    baseLevel = "read";
    await expectForbidden(await app().request(path(`/templates/${templatePublicId}/records/lookup?q=recipient`)));
    expect(lookupInput).toBeUndefined();

    baseLevel = "write";
    const response = await app().request(
      path(`/templates/${templatePublicId}/records/lookup?q=recipient&limit=7&excludeIds=${excludedRecordPublicId}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ id: lookupRecordPublicId, label: "Invoice recipient" }] });
    expect(lookupInput).toEqual({
      targetTableId: tableId,
      q: "recipient",
      limit: 7,
      excludeIds: [excludedRecordId],
    });
  });

  test("requires base admin to look up records through a disabled template", async () => {
    currentTemplate = disabledTemplate;
    baseLevel = "write";

    await expectForbidden(await app().request(path(`/templates/${templatePublicId}/records/lookup`)));
    expect(lookupInput).toBeUndefined();

    baseLevel = "admin";
    const response = await app().request(path(`/templates/${templatePublicId}/records/lookup`));

    expect(response.status).toBe(200);
    expect(lookupInput).toEqual({
      targetTableId: tableId,
      q: "",
      limit: 10,
      excludeIds: [],
    });
  });
});
