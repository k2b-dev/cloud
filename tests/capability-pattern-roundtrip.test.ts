import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { compileCapabilities } from "../packages/cloud/src/_internal/capabilities";
import { projectSchema } from "../packages/cloud/src/_internal/capability-schemas";
import type { CapabilityDefinitions } from "../packages/cloud/src/contracts/capabilities";
import { declarationOf } from "../scripts/checks/capability-presentation";
import { packageIds, workspaceRoot } from "../scripts/workspace";

const samples = [
  "",
  "p",
  "C",
  "c",
  "{",
  "}",
  "Case report",
  "Café prüfen",
  "中文",
  "abc123",
  "ABCDEF",
  "0123456789abcdef",
  "a".repeat(64),
  "2026-11-15",
  "2026-11-15T07:00:00Z",
  "11111111-1111-4111-8111-111111111111",
  "mail@example.test",
  "/folder/file.txt",
  "<b>",
  "😀",
  "𐐀",
  "a😀b",
  "\u0085",
  "\u00ad",
  "\u200d",
  "\u2028",
  "\u2029",
  "\u202e",
  "\u{e0001}",
  "\u{e0020}",
  ...Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)),
];

function differences(pattern: string): string[] {
  const expected = new RegExp(pattern, "u");
  const reconstructed = z.fromJSONSchema({ type: "string", pattern });
  return samples.filter((value) => reconstructed.safeParse(value).success !== expected.test(value));
}

test("JSON Schema import preserves Unicode properties and code points in nested string constraints", () => {
  const source = z.object({ title: z.string().regex(/^[^<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u), letter: z.string().regex(/^\p{L}$/u) });
  const reconstructed = z.fromJSONSchema(JSON.parse(JSON.stringify(z.toJSONSchema(source))));
  for (const title of ["Case report", "Café prüfen", "😀", "p { C c }"])
    expect(reconstructed.safeParse({ title, letter: "𐐀" }).success).toBe(true);
  for (const character of ["\0", "\n", "\u0085", "\u200d", "\u2028", "\u2029", "\u202e", "\u{e0001}", "\u{e0020}"])
    expect(reconstructed.safeParse({ title: `Report${character}name`, letter: "A" }).success).toBe(false);
  for (const value of ["😀", "12", ""]) expect(reconstructed.safeParse({ title: "Report", letter: value }).success).toBe(false);
});

test("Unicode patternProperties validate both values and additional-property membership", () => {
  const reconstructed = z.fromJSONSchema({
    type: "object",
    patternProperties: { "^\\p{L}+$": { type: "boolean" } },
    additionalProperties: false,
  });
  expect(reconstructed.safeParse({ Café: true, 𐐀: false }).success).toBe(true);
  expect(reconstructed.safeParse({ Café: "wrong type" }).success).toBe(false);
  expect(reconstructed.safeParse({ "123": true }).success).toBe(false);
});

test("every registered capability pattern keeps its Unicode semantics after JSON registry transport", async () => {
  const failures: string[] = [];
  let patterns = 0;
  for (const appId of packageIds(workspaceRoot)) {
    const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
    if (!declaration) continue;
    if (declaration instanceof Error) throw declaration;
    const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
    const definitions = loaded[declaration.exportName];
    if (!definitions) throw new Error(`${declaration.file}: missing ${declaration.exportName}`);
    const { manifest } = compileCapabilities(appId, definitions);
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "pattern" && typeof child === "string") {
          patterns++;
          for (const sample of differences(child)) failures.push(`${path}.pattern: ${JSON.stringify(sample)}`);
        } else if (key === "patternProperties" && child && typeof child === "object") {
          for (const pattern of Object.keys(child)) {
            patterns++;
            const expected = new RegExp(pattern, "u");
            const actual = z.fromJSONSchema({
              type: "object",
              patternProperties: { [pattern]: { type: "boolean" } },
              additionalProperties: false,
            });
            for (const sample of samples)
              if (actual.safeParse({ [sample]: true }).success !== expected.test(sample))
                failures.push(`${path}.patternProperties: ${JSON.stringify(sample)}`);
          }
        }
        visit(child, `${path}.${key}`);
      }
    };
    for (const operation of [...manifest.queries, ...manifest.actions, ...manifest.commands]) {
      visit(JSON.parse(JSON.stringify(operation.inputSchema)), `${appId}.${operation.localId}.input`);
      if ("dataSchema" in operation) visit(JSON.parse(JSON.stringify(operation.dataSchema)), `${appId}.${operation.localId}.data`);
    }
    for (const event of manifest.events ?? []) visit(JSON.parse(JSON.stringify(event.dataSchema)), `${appId}.event.${event.localId}.data`);
    for (const subscription of manifest.subscribes ?? [])
      visit(JSON.parse(JSON.stringify(subscription.dataSchema)), `${appId}.subscription.${subscription.type}.data`);
  }
  expect(patterns).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

test("the CommonJS entry also preserves Unicode properties", () => {
  const common: typeof import("zod") = createRequire(import.meta.url)("zod");
  const pattern = String.raw`^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$`;
  const schema = common.z.fromJSONSchema({ type: "string", pattern });
  expect(schema.safeParse("Case report 😀").success).toBe(true);
  expect(schema.safeParse("Report\u{e0020}name").success).toBe(false);
});

test("producers reject invalid Unicode patterns with their operation and schema path before registration", () => {
  const legacyPattern = new RegExp(String.raw`\q`);
  expect(() => projectSchema(z.object({ value: z.array(z.string().regex(legacyPattern)) }), "Query report input", "input")).toThrow(
    'Query report input is not JSON-Schema-round-trippable: $.properties["value"].items.pattern is not a valid Unicode regular expression',
  );
  expect(() => projectSchema(z.looseRecord(z.string().regex(legacyPattern), z.boolean()), "Query report data", "output")).toThrow(
    `$.patternProperties[${JSON.stringify(legacyPattern.source)}] is not a valid Unicode regular expression`,
  );
  expect(() => projectSchema(z.string().meta({ examples: [{ pattern: String.raw`\q` }] }), "Query report data", "output")).not.toThrow();
});
