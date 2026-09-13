import { expect, test } from "bun:test";
import { parse } from "yaml";
import { CreateDocumentTemplateSchema } from "../contracts";
import { documentProfiles } from "../document-profiles";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { DOCUMENT_TEMPLATE_REFERENCE } from "./documents-support";
import { fieldTypeReferences } from "./schema-support";

const references = ["grids.md", "grids-schema.md", "grids-documents.md", "grids-build-apps.md"];

test("schema guide lists every registered field type", async () => {
  const markdown = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids-schema.md", import.meta.url)).text();
  for (const field of fieldTypeReferences()) expect(markdown).toContain(`| \`${field.type}\` |`);
});

const sourceQueries = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "source" && typeof child === "string" && child.startsWith("from table ") ? [child] : sourceQueries(child),
  );
};

test("skill YAML query examples use parsable GQL clauses", async () => {
  let checked = 0;
  for (const file of references) {
    const markdown = await Bun.file(new URL(`../../../../skills/cloud-cli/references/${file}`, import.meta.url)).text();
    for (const block of markdown.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      for (const source of sourceQueries(parse(block[1]!))) {
        const result = parseGridsQueryDsl(source);
        expect(result.ok, `${file}: ${source}`).toBe(true);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test("template discovery includes both strict input contracts", () => {
  expect(DOCUMENT_TEMPLATE_REFERENCE.createSchema.required).toContain("renderer");
  expect(DOCUMENT_TEMPLATE_REFERENCE.createSchema.additionalProperties).toBe(false);
  expect(DOCUMENT_TEMPLATE_REFERENCE.updateSchema.properties).toHaveProperty("position");
  expect(DOCUMENT_TEMPLATE_REFERENCE.createSchema.properties).not.toHaveProperty("position");
  for (const example of DOCUMENT_TEMPLATE_REFERENCE.examples) {
    expect(CreateDocumentTemplateSchema.safeParse(example).success).toBe(true);
    if (example.renderer.kind === "profile") {
      const profile = documentProfiles.find((item) => item.id === example.renderer.id && item.version === example.renderer.version);
      expect(profile).toBeDefined();
      expect(profile?.input.safeParse(JSON.parse(example.renderer.inputTemplate!)).success).toBe(true);
    }
  }
});
