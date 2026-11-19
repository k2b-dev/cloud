import { expect, test } from "bun:test";
import { schemaTypes } from "./schema-types";

test("operations reuse a named origin union instead of repeating its local reference declarations", () => {
  const schema = {
    type: "object",
    properties: { origin: { $ref: "#/$defs/Origin" }, receipt: { $ref: "#/$defs/Origin" } },
    required: ["origin", "receipt"],
    additionalProperties: false,
    $defs: {
      Origin: {
        oneOf: [
          {
            type: "object",
            properties: { kind: { const: "person" }, id: { type: "string" } },
            required: ["kind", "id"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { kind: { const: "wakeup" }, id: { type: "string" }, scheduledAt: { type: "string" } },
            required: ["kind", "id", "scheduledAt"],
            additionalProperties: false,
          },
        ],
      },
    },
  };
  const shapes = { types: new Map<string, string>(), names: new Set<string>() };
  const first = schemaTypes(schema, "Data0", [], shapes);
  const second = schemaTypes(schema, "Data1", [], shapes);
  expect(second.type).toBe(first.type);
  expect(second.declarations).toEqual([]);
  expect(first.declarations.join("\n")).toContain('kind: "wakeup"');
  expect(first.declarations.join("\n")).toContain("scheduledAt: string");
});

test.each(["Data0", "CodePage"])("recursive references retain their local alias when sharing %s shapes", (name) => {
  const schema = {
    $ref: "#/$defs/Node",
    $defs: {
      Node: {
        type: "object",
        properties: { value: { type: "string" }, next: { $ref: "#/$defs/Node" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  };
  const result = schemaTypes(schema, name, [], { types: new Map(), names: new Set() });
  expect(result.type).toBe(`${name}Ref0`);
  expect(result.declarations.join("\n")).toContain(`type ${name}Ref0 = `);
  expect(result.declarations.join("\n")).toContain(`next?: ${name}Ref0; value: string`);
});

test("an exported result reuses its existing nested type", () => {
  const alarm = {
    type: "object",
    properties: { kind: { const: "wakeup" }, id: { type: "string" }, scheduledAt: { type: "string" } },
    required: ["kind", "id", "scheduledAt"],
    additionalProperties: false,
  };
  const shapes = { types: new Map<string, string>(), names: new Set<string>() };
  const history = schemaTypes(
    { type: "object", properties: { alarm }, required: ["alarm"], additionalProperties: false },
    "History",
    [],
    shapes,
  );
  const result = schemaTypes(alarm, "Data0", [], shapes, { name: "AlarmData", types: new Map() });
  expect(history.type).toContain(`alarm: ${result.type}`);
  expect(result.declarations).toEqual([]);
});
