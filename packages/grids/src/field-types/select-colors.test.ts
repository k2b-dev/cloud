import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as publicDto from "../api/public-dto";
import * as contracts from "../contracts";
import * as customAppContracts from "../custom-apps/contracts";
import { validateFieldConfig } from "../service/field-validation";
import { fieldTypeRegistry } from ".";
import { invalidSelectColor, normalizeSelectColor, SelectColorSchema, withNormalizedSelectColors } from "./select-colors";

const list = (color: unknown) => ({
  fields: [{ id: "status", name: "Status", type: "select", config: { options: [{ id: "open", label: "Open", color }] } }],
});

describe("select option colours", () => {
  test("are a hex colour or one of the names", () => {
    for (const color of ["#2563eb", "#25E", "blue", "yellow"]) expect(SelectColorSchema.safeParse(color).success).toBe(true);
    for (const color of ["Blue", "#2563eb80", "rgb(0 0 255)", "red blue", "var(--x)", "", 12])
      expect(SelectColorSchema.safeParse(color).success).toBe(false);
  });

  test("are written only as colours, in a select and in a list's select column", () => {
    expect(
      invalidSelectColor("select", {
        options: [
          { id: "a", label: "A", color: "#2563eb" },
          { id: "b", label: "B" },
        ],
      }),
    ).toBeNull();
    expect(invalidSelectColor("select", { options: [{ id: "a", label: "A", color: "url(x)" }] })).toBe('"url(x)"');
    expect(invalidSelectColor("object_list", list("green"))).toBeNull();
    expect(invalidSelectColor("object_list", list("not-a-colour"))).toBe('"not-a-colour"');
    expect(invalidSelectColor("text", { color: "anything" })).toBeNull();
  });

  test("a field configuration with a colour that is none is refused with the colours that are allowed", () => {
    const refused = validateFieldConfig("select", { options: [{ id: "a", label: "A", color: "url(x)" }] });
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error.message).toContain('#2563eb or one of: blue, cyan, gray, green, orange, purple, red, yellow, not "url(x)"');
    const german = validateFieldConfig("select", { options: [{ id: "a", label: "A", color: "url(x)" }] }, "de");
    if (!german.ok) expect(german.error.message).toContain("Die Farbe einer Auswahloption ist eine Hex-Farbe");
    expect(german.ok).toBe(false);
    expect(validateFieldConfig("object_list", list("url(x)")).ok).toBe(false);
    expect(validateFieldConfig("select", { options: [{ id: "a", label: "A", color: "red" }] }).ok).toBe(true);
  });

  test("read as hex: a name becomes its value, a colour that is none is dropped", () => {
    expect(normalizeSelectColor("Blue ")).toBe("#0000ff");
    expect(normalizeSelectColor("#25e")).toBe("#25e");
    expect(normalizeSelectColor("url(x)")).toBeUndefined();
    expect(
      withNormalizedSelectColors("select", {
        multiple: false,
        options: [
          { id: "a", label: "A", color: "green" },
          { id: "b", label: "B", color: "url(x)" },
          { id: "c", label: "C" },
        ],
      }),
    ).toEqual({
      multiple: false,
      options: [
        { id: "a", label: "A", color: "#008000" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
    });
    expect(withNormalizedSelectColors("object_list", list("RED")).fields).toEqual(list("#ff0000").fields);
    // a stored colour that is none never stops the field's own validation of a record
    expect(fieldTypeRegistry.select?.configSchema.safeParse({ options: [{ id: "a", label: "A", color: "url(x)" }] }).success).toBe(true);
  });
});

/** Every property named like a colour in a JSON schema, with the path that leads to it. */
const colourProperties = (schema: unknown, path: string[] = []): Array<{ path: string; schema: Record<string, unknown> }> => {
  if (typeof schema !== "object" || schema === null) return [];
  if (Array.isArray(schema)) return schema.flatMap((each, index) => colourProperties(each, [...path, String(index)]));
  const record = schema as Record<string, unknown>;
  const own =
    typeof record.properties === "object" && record.properties !== null
      ? Object.entries(record.properties as Record<string, unknown>)
          .filter(([key]) => /colou?r$/i.test(key))
          .map(([key, value]) => ({ path: [...path, key].join("."), schema: value as Record<string, unknown> }))
      : [];
  return [...own, ...Object.entries(record).flatMap(([key, value]) => colourProperties(value, [...path, key]))];
};

/** A colour schema names its values: a pattern or an enum, in every branch. */
const constrained = (schema: Record<string, unknown>): boolean => {
  const branches = (schema.anyOf ?? schema.oneOf) as Array<Record<string, unknown>> | undefined;
  if (branches) return branches.every(constrained);
  return typeof schema.pattern === "string" || Array.isArray(schema.enum) || schema.const !== undefined;
};

test("every colour a person or agent can write to Grids is a hex colour or a named one", () => {
  const schemas: Array<[string, z.ZodType]> = [
    ...Object.entries(fieldTypeRegistry).map(([type, definition]): [string, z.ZodType] => [`field ${type}`, definition.configSchema]),
    ...[publicDto, contracts, customAppContracts].flatMap((module) =>
      Object.entries(module).flatMap(([name, value]): Array<[string, z.ZodType]> => (value instanceof z.ZodType ? [[name, value]] : [])),
    ),
  ];
  const found: string[] = [];
  const loose: string[] = [];
  // a schema the walk cannot read is named here, never passed over in silence
  const skipped: string[] = [];
  for (const [name, schema] of schemas) {
    let json: unknown;
    try {
      json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    } catch {
      skipped.push(name);
      continue;
    }
    for (const property of colourProperties(json)) {
      found.push(`${name}: ${property.path}`);
      if (!constrained(property.schema)) loose.push(`${name}: ${property.path}`);
    }
  }
  // the select option colour is found, so the walk reaches it
  expect(found.some((entry) => entry.startsWith("field select:"))).toBe(true);
  expect(loose).toEqual([]);
  expect(skipped).toEqual([]);
});
