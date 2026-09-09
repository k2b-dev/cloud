import { arg, type CloudCliContext, command, confirmFlag, flag } from "@k2b/cloud/cli";
import type { MetricQueryPoint, PulseCurrentState, PulseQueryCompileResult, PulseRecordedEvent, PulseSavedQuery } from "../contracts";
import { listSavedQueries, requireRestArg, resolveBaseFromCommand, resolveSavedQueryId } from "./context";
import { baseFlag, QUERY_INPUT } from "./flags";
import { eventRows, stateRows } from "./inventory";
import { savedQueryRows } from "./rows";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, readApi, readTextInput } from "./shared";
import type { MessageResult } from "./types";

type QueryRunResult = {
  compiled: unknown;
  points: MetricQueryPoint[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
};

const runQueryText = (ctx: CloudCliContext, baseId: string, query: string): Promise<QueryRunResult> =>
  readApi<QueryRunResult>(ctx, "/query/metric-text", jsonRequest("POST", { baseId, query }));

const compileQueryText = (ctx: CloudCliContext, baseId: string, query: string): Promise<PulseQueryCompileResult> =>
  readApi<PulseQueryCompileResult>(ctx, "/query/compile-text", jsonRequest("POST", { baseId, query }));

export const queryCommands = [
  command("query compile", {
    summary: "Compile a Pulse query",
    flags: { ...baseFlag, query: QUERY_INPUT },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const query = await readTextInput(flags.query, "query", 2000);
      const result = await compileQueryText(ctx, base.id, query);
      if (printStructured(ctx, result)) return;
      if (result.ok) ctx.print("Query is valid.");
      else {
        for (const diagnostic of result.diagnostics) ctx.print(`${diagnostic.severity}: ${diagnostic.message}`);
      }
    },
  }),
  command("query run", {
    summary: "Run a Pulse query",
    flags: { ...baseFlag, query: QUERY_INPUT },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const query = await readTextInput(flags.query, "query", 2000);
      const result = await runQueryText(ctx, base.id, query);
      if (printStructured(ctx, result)) return;
      if (result.points.length) {
        printJsonOrTable(
          ctx,
          result,
          result.points.map((point) => ({ bucket: point.bucket, value: point.value ?? "" })),
          [{ key: "bucket" }, { key: "value" }],
        );
      } else if (result.events.length) {
        printJsonOrTable(ctx, result, eventRows(result.events), [{ key: "kind" }, { key: "value" }, { key: "entity" }, { key: "ts" }]);
      } else if (result.states.length) {
        printJsonOrTable(ctx, result, stateRows(result.states), [
          { key: "key" },
          { key: "value" },
          { key: "entity" },
          { key: "updatedAt" },
        ]);
      } else {
        ctx.print("No rows.");
      }
    },
  }),
  command("query list", {
    summary: "List saved queries",
    flags: baseFlag,
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const queries = await listSavedQueries(ctx, base.id);
      printJsonOrTable(ctx, queries, savedQueryRows(queries), [{ key: "id" }, { key: "name" }, { key: "query" }, { key: "updatedAt" }]);
    },
  }),
  command("query save", {
    summary: "Save a Pulse query",
    flags: {
      ...baseFlag,
      name: flag.string({ required: true, description: "Saved query name" }),
      description: flag.string({ description: "Saved query description" }),
      query: QUERY_INPUT,
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const query = await readTextInput(flags.query, "query", 2000);
      const compile = await compileQueryText(ctx, base.id, query);
      if (!compile.ok) throw new Error(`Query is invalid: ${compile.diagnostics.map((item) => item.message).join("; ")}`);
      const saved = await readApi<PulseSavedQuery>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/saved-queries`,
        jsonRequest("POST", { name: flags.name, description: flags.description ?? null, query }),
      );
      if (!printStructured(ctx, saved)) ctx.print(`Saved query ${saved.name} (${saved.id}).`);
    },
  }),
  command("query delete", {
    summary: "Delete a saved query",
    flags: { ...baseFlag, yes: confirmFlag("Delete this saved query") },
    args: { args: arg.rest({ valueLabel: "base query", required: true }) },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Refusing to delete without --yes.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const queryId = await resolveSavedQueryId(ctx, base.id, requireRestArg(rest, 0, "saved query"));
      const result = await readApi<MessageResult>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/saved-queries/${encodeURIComponent(queryId)}`,
        jsonRequest("DELETE"),
      );
      printMessage(ctx, result, result.message);
    },
  }),
];
