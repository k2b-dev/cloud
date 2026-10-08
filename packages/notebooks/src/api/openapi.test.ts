import { expect, test } from "bun:test";
import { hc } from "hono/client";
import { generateSpecs } from "hono-openapi";
import app from "./index";

type Schema = { $ref?: string; items?: Schema; properties?: Record<string, Schema> };
type Operation = { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> };
type Spec = {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};

const responseSchema = (spec: Spec, path: string, method: "get" | "post" = "get", status = "200") =>
  spec.paths[path]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema;

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
