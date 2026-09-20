import { expect, test } from "bun:test";
import { parse } from "yaml";
import { PublicFormConfigSchema } from "../api/public-dto";
import { gridsCommands } from "../cli";
import { CreateDocumentTemplateSchema } from "../contracts";
import { documentProfiles } from "../document-profiles";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { DOCUMENT_TEMPLATE_REFERENCE } from "./documents-support";
import { fieldTypeReferences } from "./schema-support";
import { filterOperatorsForType, validateFilterValue } from "../service/filter-compiler-validation";

const references = ["grids.md", "grids-schema.md", "grids-documents.md", "grids-build-apps.md"];

test("form guide covers the public config, input properties and validation operators", async () => {
  const markdown = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids-schema.md", import.meta.url)).text();
  const guide = markdown.split("## Forms")[1]!;
  for (const key of Object.keys(PublicFormConfigSchema.shape)) expect(guide).toContain(`\`${key}\``);
  for (const entry of PublicFormConfigSchema.shape.fields.element.options) {
    for (const key of Object.keys(entry.shape)) expect(guide).toContain(key);
  }
  for (const operator of PublicFormConfigSchema.shape.validations.unwrap().element.shape.operator.options) {
    expect(guide).toContain(`\`${operator}\``);
  }
});

test("command index covers every registered Grids command", async () => {
  const markdown = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();
  const index = markdown.split("## Command index")[1]!.match(/```text\n([\s\S]*?)```/)![1]!;
  const paths = index.trim().split("\n").flatMap((line) => {
    const parts = line.split(" ");
    const verbs = parts.pop()!.split("|");
    return verbs.map((verb) => [...parts, verb].join(" "));
  });
  for (const command of gridsCommands) expect(paths).toContain(command.path.join(" "));
});

test("operator discovery names every Grids setting", async () => {
  const markdown = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();
  const config = await Bun.file(new URL("../config.ts", import.meta.url)).text();
  const settings = [...config.matchAll(/^    "(grids\.[^"]+)":/gm)].map((match) => match[1]!);
  expect(settings.length).toBeGreaterThan(0);
  for (const name of settings) expect(markdown).toContain(`\`${name}\``);
});

test("schema guide lists every registered field type", async () => {
  const markdown = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids-schema.md", import.meta.url)).text();
  for (const field of fieldTypeReferences()) expect(markdown).toContain(`| \`${field.type}\` |`);
});

test("JSON filter discovery and guide cover the compiler operators", async () => {
  const markdown = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids-schema.md", import.meta.url)).text();
  const guide = markdown.split("## JSON filters")[1]!.split("## Forms")[0]!;
  for (const field of fieldTypeReferences()) {
    expect(field.filterOperators).toEqual([...filterOperatorsForType(field.type)]);
    for (const operator of field.filterOperators) expect(guide).toContain(`\`${operator}\``);
  }
  expect(validateFilterValue("boolean", "=", true)).toBeNull();
  expect(filterOperatorsForType("boolean").has("eq")).toBe(false);
  expect(filterOperatorsForType("text").has("eq")).toBe(false);
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
