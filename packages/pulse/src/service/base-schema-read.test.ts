import { describe, expect, test } from "bun:test";
import {
  type BaseSchemaRead,
  BaseSchemaReadSchema,
  SCHEMA_FIELD_SAMPLE_ROWS,
  SCHEMA_MAX_FIELDS,
  SCHEMA_NAME_MAX_LENGTH,
  SCHEMA_SAMPLE_ROWS,
  SchemaReadInputSchema,
} from "../schema-contracts";
import { prepareSql, SQL_MAX_BYTES } from "../sql-params";
import { READ_VIEWS } from "../store/base-schema";
import { fitSchemaResult, parseJsonObject, schemaStatements, sqlStringLiteral, summarizeAttributeFields } from "./base-schema-read";

// kind, total, field, present, string, number, boolean, object, array, null, field_count
const row = (kind: string, total: number, field: string, present: number, types: Partial<Record<string, number>>, fieldCount = 1) => [
  kind,
  String(total),
  field,
  String(present),
  ...["string", "number", "boolean", "object", "array", "null"].map((type) => String(types[type] ?? 0)),
  String(fieldCount),
];

describe("attribute field inference", () => {
  test("reports the dominant non-null type, every observed type and the fill rate", () => {
    const kinds = summarizeAttributeFields([
      row("order.created", 4, "", 1, {}, 4),
      row("order.created", 4, "amount", 3, { number: 2, string: 1 }, 4),
      row("order.created", 4, "note", 2, { null: 2 }, 4),
      row("order.created", 4, "paid", 1, { boolean: 1 }, 4),
      row("order.created", 4, "items", 1, { array: 1, null: 0 }, 4),
      row("page_view", 2, "path", 2, { string: 2 }),
    ]);
    const order = kinds.get("order.created");
    expect(order?.sampledRows).toBe(4);
    expect(order?.fieldsTruncated).toBe(false);
    expect(order?.fields).toEqual([
      { key: "amount", type: "number", types: ["number", "string"], present: 3, fillRate: 0.75 },
      { key: "note", type: "null", types: ["null"], present: 2, fillRate: 0.5 },
      { key: "paid", type: "boolean", types: ["boolean"], present: 1, fillRate: 0.25 },
      { key: "items", type: "array", types: ["array"], present: 1, fillRate: 0.25 },
    ]);
    expect(kinds.get("page_view")?.fields).toEqual([{ key: "path", type: "string", types: ["string"], present: 2, fillRate: 1 }]);
  });

  test("a null value never wins over a real type, and an object stays an object", () => {
    const [field] = summarizeAttributeFields([row("k", 10, "meta", 10, { null: 7, object: 3 })]).get("k")!.fields;
    expect(field).toMatchObject({ type: "object", types: ["null", "object"], fillRate: 1 });
  });

  test("kinds whose events carry no attributes still report their sample size", () => {
    expect(summarizeAttributeFields([row("heartbeat", 7, "", 7, {}, 0)]).get("heartbeat")).toEqual({
      sampledRows: 7,
      fields: [],
      fieldsTruncated: false,
    });
  });

  test("store output is clamped to the contract bounds", () => {
    const many = Array.from({ length: SCHEMA_MAX_FIELDS + 5 }, (_, index) =>
      row("wide", SCHEMA_FIELD_SAMPLE_ROWS * 2, `f${index}`, SCHEMA_FIELD_SAMPLE_ROWS * 3, { string: 1 }, SCHEMA_MAX_FIELDS + 5),
    );
    const wide = summarizeAttributeFields([...many, row("x".repeat(10), 1, "y".repeat(SCHEMA_NAME_MAX_LENGTH + 20), 1, { string: 1 })]);
    const entry = wide.get("wide")!;
    expect(entry.fields).toHaveLength(SCHEMA_MAX_FIELDS);
    expect(entry.fieldsTruncated).toBe(true);
    expect(entry.sampledRows).toBe(SCHEMA_FIELD_SAMPLE_ROWS);
    expect(entry.fields.every((field) => field.present === SCHEMA_FIELD_SAMPLE_ROWS && field.fillRate === 1)).toBe(true);
    expect(wide.get("x".repeat(10))!.fields[0]!.key).toHaveLength(SCHEMA_NAME_MAX_LENGTH);
  });

  test("malformed rows are ignored instead of invented", () => {
    const kinds = summarizeAttributeFields([[null, "1", "a", "1"], row("k", 0, "a", 1, { string: 1 }), row("k", 3, "b", 2, {})]);
    expect([...kinds.keys()]).toEqual(["k"]);
    expect(kinds.get("k")!.fields).toEqual([]);
  });
});

describe("store statements", () => {
  const odd = ["5m", "12", "2026-10-20", "it's \\ odd", ":param {x} -- /* $ #", "ä".repeat(SCHEMA_NAME_MAX_LENGTH)];
  const statements = (kind?: string) => [
    schemaStatements.eventFields({ since: Date.UTC(2026, 9, 10), kind }),
    ...(kind === undefined
      ? []
      : [
          schemaStatements.eventSamples({ since: Date.UTC(2026, 9, 10), kind }),
          schemaStatements.metricSamples({ since: Date.UTC(2026, 9, 10), metric: kind }),
          schemaStatements.stateSamples({ key: kind }),
        ]),
  ];

  test("read only the base's read views, never the confidential block or payload", () => {
    for (const kind of [undefined, ...odd])
      for (const statement of statements(kind)) {
        const code = kind === undefined ? statement : statement.split(sqlStringLiteral(kind)).join("''");
        expect(code).not.toMatch(/sensitive|payload|\b_[a-z]+/i);
        const tables = [...code.matchAll(/\b(?:FROM|(?<!ARRAY\s)JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)/g)].map((match) => match[1]);
        for (const table of tables) expect(READ_VIEWS as readonly string[]).toContain(table!);
      }
  });

  test("names stay data: every statement passes the SQL scanner and its size limit", () => {
    for (const kind of [undefined, ...odd])
      for (const statement of statements(kind)) {
        expect(() => prepareSql(statement, {}, "Europe/Berlin")).not.toThrow();
        expect(new TextEncoder().encode(statement).byteLength).toBeLessThanOrEqual(SQL_MAX_BYTES);
      }
  });

  test("string literals escape quotes and backslashes", () => {
    expect(sqlStringLiteral("it's \\ odd")).toBe("'it\\'s \\\\ odd'");
  });

  test("field sampling is bounded per kind and per field list", () => {
    const statement = schemaStatements.eventFields({ since: 0 });
    expect(statement).toContain(`LIMIT ${SCHEMA_FIELD_SAMPLE_ROWS} BY kind`);
    expect(statement).toContain(`LIMIT ${SCHEMA_MAX_FIELDS + 1} BY kind`);
    expect(schemaStatements.eventSamples({ since: 0, kind: "a" })).toContain(`LIMIT ${SCHEMA_SAMPLE_ROWS}`);
  });
});

const sampleResult = (kinds: number, samplesPerKind: number): BaseSchemaRead => ({
  baseId: "Base01",
  generatedAt: "2026-10-20T10:00:00.000Z",
  kind: null,
  truncated: false,
  metrics: { total: 0, items: [] },
  states: { total: 0, items: [] },
  events: {
    total: kinds,
    items: Array.from({ length: kinds }, (_, index) => ({
      kind: `kind.${index}`,
      firstSeenAt: "2026-10-01T10:00:00.000Z",
      lastSeenAt: "2026-10-20T10:00:00.000Z",
      sampledRows: 100,
      fieldsTruncated: false,
      fields: Array.from({ length: SCHEMA_MAX_FIELDS }, (_, field) => ({
        key: `field_${field}_${"x".repeat(60)}`,
        type: "string" as const,
        types: ["string" as const],
        present: 100,
        fillRate: 1,
      })),
      samples: Array.from({ length: samplesPerKind }, () => ({
        id: crypto.randomUUID(),
        ts: "2026-10-20T10:00:00.000Z",
        value: null,
        sourceId: null,
        actorId: "",
        sessionId: "",
        correlationId: "",
        resourceKey: "",
        dimensions: null,
        attributes: { text: "y".repeat(1500) },
        attributesTruncated: false,
      })),
    })),
  },
});

describe("result budget", () => {
  test("a small result stays unchanged", () => {
    const result = sampleResult(2, 2);
    expect(fitSchemaResult(result)).toBe(result);
  });

  test("a large result drops samples first, then fields, and says so", () => {
    const full = sampleResult(4, SCHEMA_SAMPLE_ROWS);
    const sampleBytes = Buffer.byteLength(JSON.stringify(full.events.items[0]!.samples));
    // Room for every field and the samples of the first kind only.
    const budget = Buffer.byteLength(JSON.stringify(full)) - 3 * (sampleBytes - "null".length);
    const samplesOnly = fitSchemaResult(full, budget);
    expect(Buffer.byteLength(JSON.stringify(samplesOnly))).toBeLessThanOrEqual(budget);
    expect(samplesOnly.truncated).toBe(true);
    expect(samplesOnly.events.items.map((item) => item.samples === null)).toEqual([false, true, true, true]);
    expect(samplesOnly.events.items.every((item) => item.fields !== null)).toBe(true);

    const huge = fitSchemaResult(sampleResult(200, SCHEMA_SAMPLE_ROWS));
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(240 * 1024);
    expect(huge.truncated).toBe(true);
    expect(huge.events.items.every((item) => item.samples === null)).toBe(true);
    expect(huge.events.items[0]!.fields).not.toBeNull();
    expect(BaseSchemaReadSchema.safeParse(huge).success).toBe(true);
  });

  test("entries are removed only when nothing else fits", () => {
    const tiny = fitSchemaResult(sampleResult(50, 0), 2_000);
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(2_000);
    expect(tiny.events.items.length).toBeLessThan(50);
    expect(tiny.events.total).toBe(50);
  });
});

describe("contract bounds", () => {
  test("the kind filter is one bounded name without control characters", () => {
    expect(SchemaReadInputSchema.safeParse({}).success).toBe(true);
    expect(SchemaReadInputSchema.safeParse({ kind: "order.created" }).success).toBe(true);
    expect(SchemaReadInputSchema.safeParse({ kind: "" }).success).toBe(false);
    expect(SchemaReadInputSchema.safeParse({ kind: "x".repeat(SCHEMA_NAME_MAX_LENGTH + 1) }).success).toBe(false);
    expect(SchemaReadInputSchema.safeParse({ kind: "a\nb" }).success).toBe(false);
    expect(SchemaReadInputSchema.safeParse({ kind: "a", sql: "SELECT 1" }).success).toBe(false);
  });

  test("the result refuses more samples or fields than the contract allows", () => {
    const valid = sampleResult(1, SCHEMA_SAMPLE_ROWS);
    expect(BaseSchemaReadSchema.safeParse(valid).success).toBe(true);
    const event = valid.events.items[0]!;
    const tooManySamples = structuredClone(valid);
    tooManySamples.events.items[0]!.samples = [...event.samples!, event.samples![0]!];
    expect(BaseSchemaReadSchema.safeParse(tooManySamples).success).toBe(false);
    const tooManyFields = structuredClone(valid);
    tooManyFields.events.items[0]!.fields = [...event.fields!, event.fields![0]!];
    expect(BaseSchemaReadSchema.safeParse(tooManyFields).success).toBe(false);
    const badRate = structuredClone(valid);
    badRate.events.items[0]!.fields![0]!.fillRate = 1.5;
    expect(BaseSchemaReadSchema.safeParse(badRate).success).toBe(false);
  });

  test("sample JSON is parsed as an object or dropped", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("")).toBeNull();
    expect(parseJsonObject("[1]")).toBeNull();
    expect(parseJsonObject('{"a":')).toBeNull();
  });
});
