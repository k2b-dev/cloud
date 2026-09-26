import { arg, type CloudCliContext, command, confirmFlag, flag } from "@k2b/cloud/cli";
import { recordArgs, requirePublicId, resolveRecordFromCommand } from "./resources";
import { jsonRequest, printCliStructured, printJsonOrMessage, queryString, readApi, readTextInput, requireRestArg } from "./runtime";

const commentArgs = {
  args: arg.rest({
    valueLabel: "record-comment",
    description: "Record as <base>:<table>/<record id>, a record ID, or <table> <record>, then the comment public ID.",
  }),
};
const recordPath = async (ctx: CloudCliContext, args: string[], after = 0) => {
  const { table, recordId, rest } = await resolveRecordFromCommand(ctx, args, after);
  return { path: `/records/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}`, rest };
};
const commentPath = async (ctx: CloudCliContext, args: string[]) => {
  const { path, rest } = await recordPath(ctx, args, 1);
  return `${path}/comments/${requirePublicId(requireRestArg(rest, 0, "comment"), "Comment")}`;
};
const pageFlags = {
  cursor: flag.string({ description: "Opaque nextCursor from the previous page" }),
  limit: flag.int({ min: 1, max: 100, default: 20, description: "Maximum results on this page" }),
};
const bodyFlag = flag.input({ name: "body", fileName: "body-file", stdinName: "stdin", required: true, description: "Comment Markdown" });

export const recordDiscussionCommands = [
  command("records referenced-by", {
    summary: "List readable live records referencing one record",
    args: recordArgs,
    flags: { ...pageFlags, relationField: flag.string({ name: "relation-field", description: "Filter by relation Field public ID" }) },
    async run({ ctx, args, flags }) {
      const page = await readApi<unknown>(
        ctx,
        `${(await recordPath(ctx, args.args)).path}/referenced-by${queryString({
          cursor: flags.cursor,
          limit: flags.limit,
          relationFieldId: flags.relationField ? requirePublicId(flags.relationField, "Relation field") : undefined,
        })}`,
      );
      if (!printCliStructured(ctx, page)) ctx.json(page);
    },
  }),
  command("records comments list", {
    summary: "Read one bounded page of record comments and current permissions",
    args: recordArgs,
    flags: pageFlags,
    async run({ ctx, args, flags }) {
      const page = await readApi<unknown>(ctx, `${(await recordPath(ctx, args.args)).path}/comments${queryString(flags)}`);
      if (!printCliStructured(ctx, page)) ctx.json(page);
    },
  }),
  command("records comments create", {
    summary: "Add a comment to a record",
    args: recordArgs,
    flags: { body: bodyFlag },
    async run({ ctx, args, flags }) {
      const body = await readTextInput(flags.body, "comment");
      const result = await readApi<unknown>(ctx, `${(await recordPath(ctx, args.args)).path}/comments`, jsonRequest("POST", { body }));
      printJsonOrMessage(ctx, result, "Added record comment.");
    },
  }),
  command("records comments update", {
    summary: "Edit a record comment as its author or a Base moderator",
    args: commentArgs,
    flags: { body: bodyFlag },
    async run({ ctx, args, flags }) {
      const body = await readTextInput(flags.body, "comment");
      const result = await readApi<unknown>(ctx, await commentPath(ctx, args.args), jsonRequest("PATCH", { body }));
      printJsonOrMessage(ctx, result, "Updated record comment.");
    },
  }),
  command("records comments delete", {
    summary: "Delete a record comment as its author or a Base moderator",
    args: commentArgs,
    flags: { yes: confirmFlag("Delete the comment") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete the comment.");
      const response = await ctx.fetch(`/api/grids${await commentPath(ctx, args.args)}`, { method: "DELETE" });
      if (!response.ok) await ctx.readJson(response);
      printJsonOrMessage(ctx, { deleted: true }, "Deleted record comment.");
    },
  }),
] as const;
