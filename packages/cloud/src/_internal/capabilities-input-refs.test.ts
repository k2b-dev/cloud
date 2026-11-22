import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { compileCapabilities } from "./capabilities";

const str = () => z.string().describe("A value.");
const definitions = (input: z.ZodType, extra: Record<string, unknown> = {}): CapabilityDefinitions =>
  ({
    protocolVersion: 2,
    types: {
      base: { title: "Base", description: "A base.", reader: "base.read" },
    },
    queries: {
      "base.read": {
        title: "Read base",
        description: "Read one base.",
        input: z.object({ id: str() }).strict(),
        data: z.object({ id: str() }).strict(),
        openWorld: false,
        run: async (value: { id: string }) => ok({ data: value }),
      },
      "sql.run": {
        title: "Run SQL",
        description: "Run SQL in one base.",
        input,
        data: z.object({ rows: z.array(z.unknown()).describe("Rows.") }).strict(),
        openWorld: false,
        inputRefs: { baseId: "base" },
        run: async () => ok({ data: { rows: [] } }),
        ...extra,
      },
    },
  }) as unknown as CapabilityDefinitions;

test("inputRefs name a required string field of a declared type and reach the manifest (G1)", () => {
  const manifest = compileCapabilities("example", definitions(z.object({ baseId: str(), sql: str() }).strict())).manifest;
  expect(manifest.queries.find((query) => query.localId === "sql.run")?.inputRefs).toEqual({ baseId: "base" });
});

test("inputRefs refuse an optional field, a default, a non-string field and a Query with a target", () => {
  for (const input of [
    z.object({ baseId: str().optional(), sql: str() }).strict(),
    z.object({ baseId: str().default("Base01"), sql: str() }).strict(),
    z.object({ baseId: z.number().describe("A number."), sql: str() }).strict(),
    z.object({ sql: str() }).strict(),
  ])
    expect(() => compileCapabilities("example", definitions(input))).toThrow(/inputRefs/);
  expect(() => compileCapabilities("example", definitions(z.object({ baseId: str() }).strict(), { target: "base" }))).toThrow(/inputRefs/);
});
