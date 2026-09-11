import { arg, command, flag, confirmFlag, readCliInput, printStructured, type CloudCliContext } from "@k2b/cloud/cli";
import { PublicId } from "../contracts";
import { QueryId, QueryInput, QueryUpdate, QueryRevision, type SavedQuery } from "../saved-queries";
const appArgs = { id: arg.required({ description: "Kit app short id" }) };
const queryArgs = { ...appArgs, query: arg.required({ description: "Saved query id" }) };
const input = { input: flag.input({ description: "JSON object from file or stdin", required: true }) };
const path = (id: string) => `/projects/${PublicId.parse(id)}/queries`;
const exact = (id: string, q: string) => `${path(id)}/${QueryId.parse(q)}`;
const read = async (value: Parameters<typeof readCliInput>[0]) =>
  JSON.parse((await readCliInput(value, { required: true, label: "Saved query JSON" })) ?? "");
const request = async <T>(ctx: CloudCliContext, path: string, method = "GET", body?: unknown) =>
  ctx.readJson<T>(
    await ctx.fetch(`/api/kit${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const output = (ctx: CloudCliContext, value: unknown) => {
  if (!printStructured(ctx, value)) ctx.print(JSON.stringify(value, null, 2));
};
export const queryCommands = [
  command("queries list", {
    summary: "List shared queries (50 per page; Use)",
    args: appArgs,
    flags: { page: flag.int({ default: 1 }), name: flag.string({ description: "Exact saved query name" }) },
    async run({ ctx, args, flags }) {
      output(ctx, await request(ctx, `${path(args.id)}?page=${flags.page}${flags.name ? `&name=${encodeURIComponent(flags.name)}` : ""}`));
    },
  }),
  command("queries get", {
    summary: "Read saved SQL and revision (Use)",
    args: queryArgs,
    async run({ ctx, args }) {
      output(ctx, await request(ctx, exact(args.id, args.query)));
    },
  }),
  command("queries create", {
    summary: "Save shared SQL; JSON {name,sql} (Admin)",
    args: appArgs,
    flags: input,
    async run({ ctx, args, flags }) {
      output(ctx, await request(ctx, path(args.id), "POST", QueryInput.parse(await read(flags.input))));
    },
  }),
  command("queries update", {
    summary: "Update or rename; JSON {name,sql,revision} (Admin)",
    args: queryArgs,
    flags: input,
    async run({ ctx, args, flags }) {
      output(ctx, await request(ctx, exact(args.id, args.query), "PUT", QueryUpdate.parse(await read(flags.input))));
    },
  }),
  command("queries delete", {
    summary: "Delete a query at its exact revision (Admin)",
    args: queryArgs,
    flags: { revision: flag.int({ required: true }), yes: confirmFlag("Delete saved query") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Deletion requires --yes");
      output(ctx, await request(ctx, exact(args.id, args.query), "DELETE", QueryRevision.parse({ revision: flags.revision })));
    },
  }),
  command("queries run", {
    summary: "Explicitly execute saved SELECT at the supplied revision (Use)",
    args: queryArgs,
    flags: { revision: flag.int({ required: true }) },
    async run({ ctx, args, flags }) {
      const query = await request<SavedQuery>(ctx, exact(args.id, args.query));
      if (query.revision !== flags.revision) throw new Error("Query revision changed; read it before running.");
      const state = await request<{ generation: number }>(ctx, `/projects/${PublicId.parse(args.id)}/database`);
      output(
        ctx,
        await request(ctx, `/projects/${PublicId.parse(args.id)}/database/call`, "POST", {
          generation: state.generation,
          request: { operation: "query", sql: query.sql, params: [] },
        }),
      );
    },
  }),
];
