import { expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import app from "./index";

type Schema = { $ref?: string; items?: Schema; properties?: Record<string, Schema> };
type Spec = {
  paths: Record<string, { get?: { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> } }>;
  components?: { schemas?: Record<string, Schema> };
};

const responseSchema = (spec: Spec, path: string) => spec.paths[path]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;

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
