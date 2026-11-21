import { arg, type CloudCliContext, command, flag } from "@k2b/cloud/cli";
import { type BaseSchemaRead, BaseSchemaReadSchema } from "../schema-contracts";
import { resolveBaseFromCommand } from "./context";
import { baseFlag } from "./flags";
import { printStructured, queryString } from "./shared";
import { sqlExitCode } from "./sql";

// Only Pulse's fixed error classes may supply a message. Never reflect arbitrary upstream bodies.
const KNOWN_CODES = [
  "BAD_INPUT",
  "TIME_LIMIT",
  "MEMORY_LIMIT",
  "RESULT_TOO_LARGE",
  "BUSY",
  "QUEUE_FULL",
  "QUOTA",
  "STORE_UNAVAILABLE",
  "NO_READ_ACCESS",
  "CANCELLED",
];

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

const printText = (ctx: CloudCliContext, schema: BaseSchemaRead) => {
  if (schema.metrics.items.length) {
    ctx.print(`Metrics (${schema.metrics.items.length} of ${schema.metrics.total})`);
    ctx.table(
      schema.metrics.items.map((metric) => ({
        name: metric.name,
        type: metric.type,
        unit: metric.unit ?? "",
        series: metric.seriesCount,
        dimensions: metric.dimensions.map((dimension) => dimension.key).join(", "),
        lastSampleAt: metric.lastSampleAt ?? "",
      })),
      [{ key: "name" }, { key: "type" }, { key: "unit" }, { key: "series" }, { key: "dimensions" }, { key: "lastSampleAt" }],
    );
  }
  if (schema.events.items.length) {
    ctx.print(`Event kinds (${schema.events.items.length} of ${schema.events.total})`);
    ctx.table(
      schema.events.items.map((event) => ({
        kind: event.kind,
        sampled: event.sampledRows,
        fields:
          event.fields === null ? "" : event.fields.map((field) => `${field.key}:${field.type} ${percent(field.fillRate)}`).join(", "),
        lastSeenAt: event.lastSeenAt,
      })),
      [{ key: "kind" }, { key: "sampled" }, { key: "fields" }, { key: "lastSeenAt" }],
    );
  }
  if (schema.states.items.length) {
    ctx.print(`State keys (${schema.states.items.length} of ${schema.states.total})`);
    ctx.table(
      schema.states.items.map((state) => ({ key: state.key, variants: state.variantCount, updatedAt: state.updatedAt ?? "" })),
      [{ key: "key" }, { key: "variants" }, { key: "updatedAt" }],
    );
  }
  const samples: unknown[] = [];
  for (const item of [...schema.metrics.items, ...schema.events.items, ...schema.states.items]) samples.push(...(item.samples ?? []));
  if (samples.length) {
    ctx.print("Newest entries");
    for (const sample of samples) ctx.print(JSON.stringify(sample));
  }
  if (!schema.metrics.total && !schema.events.total && !schema.states.total)
    ctx.print(schema.kind === null ? "This base has no data yet." : `No metric, event kind or state key is named "${schema.kind}".`);
  if (schema.truncated) ctx.error("The result was shortened to its limits. Pass --kind to read one kind.");
};

export const schemaCommand = command("schema", {
  summary: "List the data kinds and event fields of a Pulse base",
  description:
    "Shows metrics, event kinds with attribute fields (type and fill rate from the newest events), and state keys. --kind adds the five newest entries of one kind. Confidential event data is never shown. See the schema reference.",
  args: { args: arg.rest({ valueLabel: "base" }) },
  flags: { ...baseFlag, kind: flag.string({ description: "Exact name of one metric, event kind or state key" }) },
  examples: ["cld pulse schema Base01", "cld pulse schema Base01 --kind order.created --json"],
  async run({ ctx, args, flags }) {
    const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
    let response: Response;
    try {
      response = await ctx.fetch(`/api/pulse/bases/${encodeURIComponent(base.id)}/schema${queryString({ kind: flags.kind })}`);
    } catch {
      ctx.error("STORE_UNAVAILABLE: The Pulse schema request failed.");
      return sqlExitCode("STORE_UNAVAILABLE");
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "STORE_UNAVAILABLE";
      const message =
        KNOWN_CODES.includes(code) && body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : "The Pulse schema request failed.";
      ctx.error(`${code}: ${message}`);
      return sqlExitCode(code);
    }
    const schema = BaseSchemaReadSchema.safeParse(await response.json().catch(() => null));
    if (!schema.success) {
      ctx.error("STORE_UNAVAILABLE: The Pulse schema response was not readable.");
      return sqlExitCode("STORE_UNAVAILABLE");
    }
    if (!printStructured(ctx, schema.data)) printText(ctx, schema.data);
    return 0;
  },
});
