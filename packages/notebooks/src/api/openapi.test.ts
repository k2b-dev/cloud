import { expect, test } from "bun:test";
import { hc } from "hono/client";
import { generateSpecs } from "hono-openapi";
import app from "./index";

type Schema = {
  $ref?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  nullable?: boolean;
  type?: string | string[];
  anyOf?: Schema[];
};
type Operation = {
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: Schema }>;
      headers?: Record<
        string,
        { required?: boolean; description?: string; schema?: { type?: string; maxLength?: number; pattern?: string } }
      >;
    }
  >;
};
type Spec = {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};

const responseSchema = (spec: Spec, path: string, method: "get" | "post" = "get", status = "200") =>
  spec.paths[path]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema;

test("graph nodes document hierarchy, manual position, and last change", async () => {
  const spec = (await generateSpecs(app)) as Spec;
  const resolve = (schema?: Schema): Schema | undefined =>
    schema?.$ref ? resolve(spec.components?.schemas?.[schema.$ref.replace("#/components/schemas/", "")]) : schema;
  const response = resolve(responseSchema(spec, "/{id}/graph"));
  const data = resolve(response?.properties?.data);
  const nodes = resolve(data?.properties?.nodes);
  const node = resolve(nodes?.items);
  expect(Object.keys(node?.properties ?? {}).sort()).toEqual(["id", "inDegree", "parentId", "position", "title", "updatedAt"]);
  const parent = resolve(node?.properties?.parentId);
  expect(
    parent?.nullable === true ||
      parent?.type === "null" ||
      (Array.isArray(parent?.type) && parent.type.includes("null")) ||
      parent?.anyOf?.some((schema) => resolve(schema)?.type === "null") === true,
  ).toBe(true);
});

test("the note tree and the book tree are separate OpenAPI components", async () => {
  const spec = (await generateSpecs(app)) as Spec;
  const schemas = spec.components?.schemas ?? {};

  const noteTree = responseSchema(spec, "/{id}/tree")?.items?.$ref;
  expect(noteTree).toBe("#/components/schemas/NoteTreeNode");
  expect(responseSchema(spec, "/{id}/workspace-state")?.properties?.tree?.items?.$ref).toBe(noteTree);
  expect(Object.keys(schemas.NoteTreeNode?.properties ?? {})).toContain("notebookId");
  expect(schemas.NoteTreeNode?.properties?.children?.items?.$ref).toBe(noteTree);

  const bookTree = responseSchema(spec, "/{id}/book")?.properties?.tree?.items?.$ref;
  expect(bookTree).toBe("#/components/schemas/BookTreeNode");
  expect(Object.keys(schemas.BookTreeNode?.properties ?? {})).toEqual(["id", "title", "children"]);
  expect(schemas.BookTreeNode?.properties?.children?.items?.$ref).toBe(bookTree);
});

test("a notebook created from a template documents the same fields as every other notebook", async () => {
  const spec = (await generateSpecs(app)) as Spec;
  const fields = (schema?: Schema) => Object.keys(schema?.properties ?? {}).sort();

  const notebook = fields(responseSchema(spec, "/{id}"));
  expect(notebook).toContain("noteDeletePermission");
  expect(fields(responseSchema(spec, "/templates/{templateId}", "post", "201"))).toEqual(notebook);
});

test("alphabetical reset and outline positions are documented", async () => {
  const spec = (await generateSpecs(app)) as Spec;
  expect(responseSchema(spec, "/{id}/note-order/reset", "post")?.properties).toHaveProperty("message");
  expect(responseSchema(spec, "/{id}/outline")?.properties?.data?.items?.properties).toHaveProperty("position");
});

test("the typed client exposes alphabetical reset with its parent selection", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const client = hc<typeof app>("http://example.test", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return Response.json({ message: "Notes sorted alphabetically." });
    },
  });
  await client[":id"]["note-order"].reset.$post({ param: { id: "abc123" }, json: { parentId: null } });
  expect(requests).toEqual([{ url: "http://example.test/abc123/note-order/reset", body: { parentId: null } }]);
});

test("version restores document their public results and expose bodyless typed client actions", async () => {
  const spec = (await generateSpecs(app)) as Spec;
  const path = "/{id}/notes/{noteId}/versions/{versionId}";
  expect(Object.keys(responseSchema(spec, `${path}/restore`, "post")?.properties ?? {}).sort()).toEqual([
    "changed",
    "note",
    "previousVersionId",
    "versionId",
  ]);
  expect(responseSchema(spec, `${path}/copy`, "post")?.$ref).toBe(responseSchema(spec, "/{id}/notes", "post")?.$ref);
  for (const status of ["403", "404", "409"]) expect(responseSchema(spec, `${path}/restore`, "post", status)).toBeDefined();
  const requests: { url: string; method?: string; body: BodyInit | null | undefined }[] = [];
  const client = hc<typeof app>("http://example.test", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method, body: init?.body });
      return Response.json({});
    },
  });
  const param = { id: "abc123", noteId: "def456", versionId: "version" };
  await client[":id"].notes[":noteId"].versions[":versionId"].restore.$post({ param });
  await client[":id"].notes[":noteId"].versions[":versionId"].copy.$post({ param });
  expect(requests).toEqual([
    { url: "http://example.test/abc123/notes/def456/versions/version/restore", method: "POST", body: undefined },
    { url: "http://example.test/abc123/notes/def456/versions/version/copy", method: "POST", body: undefined },
  ]);
});

test("PDF response documents the optional bounded omission report header", async () => {
  const spec = (await generateSpecs(app)) as Spec;
  const header = spec.paths["/{id}/notes/{noteId}/pdf"]?.post?.responses?.["200"]?.headers?.["X-Notebooks-Pdf-Omissions"];
  expect(header).toMatchObject({ required: false, schema: { type: "string", maxLength: 2048, pattern: "^[A-Za-z0-9_-]+$" } });
  expect(header?.description).toContain("base64url");
  expect(header?.description).toContain("UTF-8 JSON {items:[{code,kind,label}],more}");
  expect(header?.description).toContain("marked in place");
  expect(header?.description).toContain("did not fit");
});
