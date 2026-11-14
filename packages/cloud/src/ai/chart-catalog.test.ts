import { expect, test } from "bun:test";
import { chartKindSchema } from "@k2b/editor/charts";
import { z } from "zod";
import { chartCatalog } from "./chart-catalog.generated";
import { CloudAiChartInputSchema, cloudAiAppChartSchema } from "./default-tool-contracts";
import { createCloudAiChartTool } from "./default-tools";

const tool = createCloudAiChartTool().def;
// What the provider receives once the tool is loaded, converted as the agent loop converts it.
const schema = z.toJSONSchema(tool.inputSchema, { target: "draft-07" }) as Record<string, unknown>;
const schemaDescription = String(schema.description ?? "");
const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

test("the chart tool describes every kind of the portable chart schema", () => {
  const described = new Set(chartCatalog.map((entry) => entry.example.kind));
  expect(chartKindSchema().options.filter((kind) => !described.has(kind))).toEqual([]);
  for (const entry of chartCatalog) {
    expect(entry.useFor.length, entry.name).toBeGreaterThan(0);
    expect(entry.avoidFor.length, entry.name).toBeGreaterThan(0);
    expect(tool.description).toContain(`- ${entry.name}: `);
  }
});

test("every example in the chart tool's input schema is a valid chart for the tool and for cloud.chart()", () => {
  const app = cloudAiAppChartSchema();
  for (const entry of chartCatalog) {
    expect({ name: entry.name, tool: issues(CloudAiChartInputSchema.safeParse(entry.example)) }).toEqual({ name: entry.name, tool: [] });
    expect({ name: entry.name, app: issues(app.safeParse(entry.example)) }).toEqual({ name: entry.name, app: [] });
    // The model reads the example exactly as the test parsed it, once the tool is loaded.
    expect(schemaDescription).toContain(JSON.stringify(entry.example));
  }
  // The tool still parses what it parsed before; only its schema's description is new.
  expect(tool.inputSchema.safeParse(chartCatalog[0].example).success).toBe(true);
});

test("search_tools returns the description, so it names the kinds without examples and stays short", () => {
  for (const entry of chartCatalog) expect(tool.description).not.toContain(JSON.stringify(entry.example));
  // Room for the kinds still to come; examples belong in the schema's description.
  expect(tool.description.length).toBeLessThanOrEqual(4_000);
});

/** Every property name in a JSON schema, with the strings an enum or const restricts it to (null: any value). */
const properties = (node: unknown, into = new Map<string, Set<string> | null>()) => {
  if (Array.isArray(node)) for (const item of node) properties(item, into);
  else if (node && typeof node === "object") {
    const object = node as Record<string, unknown>;
    for (const [name, field] of Object.entries((object.properties as Record<string, unknown>) ?? {})) {
      const values =
        (field as { enum?: unknown[]; const?: unknown }).enum ??
        ("const" in (field as object) ? [(field as { const: unknown }).const] : undefined);
      const known = into.get(name);
      into.set(name, known === null || !values ? null : new Set([...(known ?? []), ...values.map(String)]));
    }
    for (const value of Object.values(object)) properties(value, into);
  }
  return into;
};

test("every option and value the chart tool's texts mention is one its schema accepts", () => {
  const accepted = properties(schema);
  const mentioned = [`${tool.description}\n${schemaDescription}`.replace(/\{"kind".*$/gm, "")].flatMap((text) =>
    [...text.matchAll(/(?<![\w"])`?([A-Za-z]\w*)`?: ("([^"]*)"|true|false|null)/g)].map((match) => ({ name: match[1]!, value: match[3] })),
  );
  expect(mentioned.length).toBeGreaterThan(0);
  for (const { name, value } of mentioned) {
    expect({ name, field: accepted.has(name) }).toEqual({ name, field: true });
    const values = accepted.get(name);
    if (value !== undefined && values) expect({ name, value, accepted: values.has(value) }).toEqual({ name, value, accepted: true });
  }
});
