import { arg, command, confirmFlag, flag, paginationFlags } from "@k2b/cloud/cli";
import type { SavedQuery } from "../service/saved-queries";
import { validateSqlInput } from "../sql-params";
import { requireDefaultBaseRef } from "./context";
import { baseFlag } from "./flags";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, queryString, readApi } from "./shared";
import { parseSqlParameters, readSqlInput, sqlInputFlags } from "./sql";

export const queryCommands = [
  command("queries list", {
    summary: "List saved SQL queries in a base",
    flags: { ...baseFlag, ...paginationFlags({ defaultPerPage: 25, maxPerPage: 1000 }) },
    async run({ ctx, flags }) {
      const base = flags.base ?? (await requireDefaultBaseRef(ctx));
      const page = flags.page ?? 1;
      const perPage = flags.perPage ?? 25;
      const result = await readApi<{ items: SavedQuery[]; total: number; nextOffset: number | null }>(
        ctx,
        `/bases/${encodeURIComponent(base)}/queries${queryString({ limit: perPage, offset: (page - 1) * perPage })}`,
      );
      printJsonOrTable(ctx, result, result.items, [{ key: "id" }, { key: "name" }, { key: "revision" }, { key: "updatedAt" }]);
    },
  }),
  command("queries get", {
    summary: "Read a saved SQL query",
    args: { query: arg.required({ valueLabel: "query-id" }) },
    flags: baseFlag,
    async run({ ctx, args, flags }) {
      const base = flags.base ?? (await requireDefaultBaseRef(ctx));
      const result = await readApi<SavedQuery>(ctx, `/bases/${encodeURIComponent(base)}/queries/${encodeURIComponent(args.query)}`);
      if (!printStructured(ctx, result)) {
        ctx.print(`${result.name} (${result.id}, revision ${result.revision})`);
        ctx.print(result.sql);
      }
    },
  }),
  command("queries save", {
    summary: "Create or update a saved SQL query",
    description: "Updating requires --query and --expected-revision. Reuse --idempotency-key after a failed request.",
    args: { sql: arg.optional({ valueLabel: "sql-or--" }) },
    flags: {
      ...baseFlag,
      ...sqlInputFlags,
      name: flag.string({ required: true, description: "Saved query name" }),
      query: flag.string({ description: "Query ID to update" }),
      expectedRevision: flag.int({ name: "expected-revision", min: 1, description: "Revision returned by queries get" }),
      idempotencyKey: flag.string({ name: "idempotency-key", description: "Stable retry key for this save" }),
    },
    async run({ ctx, args, flags }) {
      if (Boolean(flags.query) !== (flags.expectedRevision !== undefined)) throw new Error("Use --query and --expected-revision together.");
      const base = flags.base ?? (await requireDefaultBaseRef(ctx));
      const sql = await readSqlInput(args.sql, flags.file);
      const params = parseSqlParameters(flags.param);
      validateSqlInput(sql, params);
      const path = `/bases/${encodeURIComponent(base)}/queries${flags.query ? `/${encodeURIComponent(flags.query)}` : ""}`;
      const request = jsonRequest(flags.query ? "PATCH" : "POST", {
        name: flags.name,
        sql,
        params,
        expectedRevision: flags.expectedRevision,
      });
      if (flags.idempotencyKey) request.headers = { ...request.headers, "Idempotency-Key": flags.idempotencyKey };
      const result = await readApi<SavedQuery>(ctx, path, request);
      if (!printStructured(ctx, result)) ctx.print(`Saved ${result.name} (${result.id}, revision ${result.revision}).`);
    },
  }),
  command("queries delete", {
    summary: "Delete a saved SQL query",
    args: { query: arg.required({ valueLabel: "query-id" }) },
    flags: { ...baseFlag, yes: confirmFlag("Delete this saved query") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Refusing to delete without --yes.");
      const base = flags.base ?? (await requireDefaultBaseRef(ctx));
      const result = await readApi<{ deleted: boolean }>(
        ctx,
        `/bases/${encodeURIComponent(base)}/queries/${encodeURIComponent(args.query)}`,
        jsonRequest("DELETE"),
      );
      printMessage(ctx, result, "Saved query deleted.");
    },
  }),
];
