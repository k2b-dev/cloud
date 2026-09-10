import { arg, command, confirmFlag, flag, readCliInput, printStructured, type CloudCliContext } from "@k2b/cloud/cli";
import { PublicId } from "../contracts";
import { DatabaseRequest, DatabaseSettings } from "../database-contracts";
import { importData } from "../database-import";
const args = { id: arg.required({ description: "Six-character Kit app id" }) };
const input = { input: flag.input({ description: "JSON input; use a private file or stdin for secrets", required: true }) };
const output = (ctx: CloudCliContext, data: unknown) => {
  if (!printStructured(ctx, data)) ctx.print(JSON.stringify(data, null, 2));
};
const request = async <T>(ctx: CloudCliContext, path: string, method = "GET", body?: unknown) =>
  ctx.readJson<T>(
    await ctx.fetch(`/api/kit${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const path = (id: string) => `/projects/${PublicId.parse(id)}/database`;
const json = async (value: Parameters<typeof readCliInput>[0]) =>
  JSON.parse((await readCliInput(value, { label: "Kit database JSON", required: true })) ?? "");
export const databaseCommands = [
  command("admin list", {
    summary: "List all Kit apps, including orphaned apps",
    flags: { page: flag.int({ default: 1 }), search: flag.string() },
    async run({ ctx, flags }) {
      output(ctx, await request(ctx, `/admin/projects?page=${flags.page}&q=${encodeURIComponent(flags.search ?? "")}`));
    },
  }),
  command("admin settings", {
    summary: "Read redacted rsql settings",
    async run({ ctx }) {
      output(ctx, await request(ctx, "/admin/settings"));
    },
  }),
  ...["configure", "test"].map((operation) =>
    command(`admin ${operation}`, {
      summary:
        operation === "test"
          ? "Test rsql credentials without creating a database"
          : "Configure rsql; pass secrets through a private file or stdin",
      flags: input,
      async run({ ctx, flags }) {
        output(
          ctx,
          await request(
            ctx,
            operation === "test" ? "/admin/settings/test" : "/admin/settings",
            operation === "test" ? "POST" : "PUT",
            DatabaseSettings.parse(await json(flags.input)),
          ),
        );
      },
    }),
  ),
  command("db status", {
    summary: "Read database state and diagnostics",
    args,
    async run({ ctx, args }) {
      output(ctx, await request(ctx, `${path(args.id)}?diagnostics=true`));
    },
  }),
  ...[true, false].map((enabled) =>
    command(`db ${enabled ? "enable" : "disable"}`, {
      summary: enabled ? "Enable the app database" : "Disable access without changing database contents",
      args,
      async run({ ctx, args }) {
        output(ctx, await request(ctx, path(args.id), "PUT", { enabled }));
      },
    }),
  ),
  command("db reset", {
    summary: "Delete every table and record in the app database",
    args,
    flags: { yes: confirmFlag("Reset all database data") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Reset requires --yes");
      output(ctx, await request(ctx, `${path(args.id)}/reset`, "POST", { confirm: true }));
    },
  }),
  command("db export", {
    summary: "Stream a SQLite snapshot to a new local file",
    args: { ...args, file: arg.required({ description: "New output filename" }) },
    async run({ ctx, args }) {
      const response = await ctx.fetch(`/api/kit${path(args.id)}/export`);
      if (!response.ok) {
        await ctx.readJson(response);
        return;
      }
      const { open, unlink } = await import("node:fs/promises");
      const file = await open(args.file, "wx");
      try {
        if (!response.body) throw new Error("Missing export stream");
        for await (const chunk of response.body) {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
            if (!bytesWritten) throw new Error("Could not write export");
            offset += bytesWritten;
          }
        }
      } catch (error) {
        await unlink(args.file);
        throw error;
      } finally {
        await file.close();
      }
      output(ctx, { file: args.file });
    },
  }),
  command("db call", {
    summary: "Execute a schema, row or SELECT operation using DatabaseRequest JSON",
    args,
    flags: input,
    async run({ ctx, args, flags }) {
      const state = await request<{ generation: number }>(ctx, path(args.id));
      output(
        ctx,
        await request(ctx, `${path(args.id)}/call`, "POST", {
          generation: state.generation,
          request: DatabaseRequest.parse(await json(flags.input)),
        }),
      );
    },
  }),
  command("db import", {
    summary: "Append JSON rows in sequential batches; never replay an ambiguous write",
    args: { ...args, table: arg.required({ description: "Target table" }) },
    flags: { ...input, create: flag.boolean({ description: "Create the missing table (admin)" }) },
    async run({ ctx, args, flags }) {
      const state = await request<{ generation: number }>(ctx, path(args.id));
      const result = await importData(args.table, await json(flags.input), { createTable: flags.create ?? false }, (req) =>
        request(ctx, `${path(args.id)}/call`, "POST", { generation: state.generation, request: req }),
      );
      output(ctx, result);
      if (result.status !== "complete") throw new Error("Import incomplete; inspect confirmedRows before taking further action");
    },
  }),
];
