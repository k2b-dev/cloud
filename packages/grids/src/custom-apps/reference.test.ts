import { expect, test } from "bun:test";
import { z } from "zod";
import { CustomAppDefinitionSchema } from "./contracts";
import { CUSTOM_APP_API_REFERENCE } from "./reference";

test("publishes the actual input schema, not the normalized output contract", () => {
  expect(CUSTOM_APP_API_REFERENCE.definitionSchema).toEqual(z.toJSONSchema(CustomAppDefinitionSchema, { io: "input" }));
  expect(CUSTOM_APP_API_REFERENCE.definitionSchema).toMatchObject({
    additionalProperties: false,
    required: ["schemaVersion", "kind", "id", "baseId", "name", "startPageId", "pages"],
  });
});

test("documents every block and option in both Help locales and the CLI skill", async () => {
  const documents = await Promise.all([
    Bun.file(new URL("../help/documents/en/grids-custom-app-api.help.md", import.meta.url)).text(),
    Bun.file(new URL("../help/documents/de/grids-custom-app-api.help.md", import.meta.url)).text(),
    Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text(),
  ]);
  const object = z.record(z.string(), z.unknown());
  const blocks = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    const parsed = object.safeParse(value);
    if (!parsed.success) return;
    const properties = object.safeParse(parsed.data.properties);
    if (properties.success && properties.data.id) {
      const type = z.object({ const: z.string() }).safeParse(properties.data.type);
      if (type.success) blocks.set(type.data.const, parsed.data);
    }
    Object.values(parsed.data).forEach(visit);
  };
  visit(CUSTOM_APP_API_REFERENCE.definitionSchema);
  expect(blocks.size).toBe(11);
  expect(Object.keys(CUSTOM_APP_API_REFERENCE.blocks).sort()).toEqual([...blocks.keys()].sort());
  for (const [type, schema] of blocks) {
    const properties = object.parse(schema.properties);
    for (const text of documents) {
      const row = text.split("\n").find((line) => line.startsWith(`| \`${type}\` |`));
      expect(row, type).toBeDefined();
      for (const key of Object.keys(properties).filter((key) => !["id", "type", "title", "availableWhen"].includes(key))) {
        expect(row, `${type}.${key}`).toContain(key);
      }
    }
  }
  expect(blocks.get("records")).toMatchObject({
    required: ["id", "type", "source", "display"],
    properties: { searchable: { default: true }, pageSize: { default: 25, minimum: 5, maximum: 100 } },
  });
  expect(blocks.get("form")).toMatchObject({ properties: { mode: { enum: ["create", "edit"] } } });
});
