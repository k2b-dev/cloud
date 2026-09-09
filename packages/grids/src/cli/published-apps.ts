import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { arg, command, confirmFlag, flag } from "@k2b/cloud/cli";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { requirePublicId } from "./resources";
import { JSON_BODY_INPUT, jsonRequest, printCliStructured, queryString, readApi, readJsonInput, writeApiFile } from "./runtime";

const appArg = { app: arg.required({ description: "Published App public ID from its URL; no Base access required" }) };
const pageArgs = { ...appArg, page: arg.required({ description: "Page ID from apps runtime read" }) };
const blockArgs = { ...pageArgs, block: arg.required({ description: "Visible block ID from apps runtime read" }) };
const paramsFlag = { params: flag.string({ description: "JSON object of page parameter names to Record public IDs" }) };
const params = (value: string | undefined) => (value ? z.record(z.string(), ShortIdSchema).parse(JSON.parse(value)) : {});
const segment = (value: string) => {
  if (!value || value === "." || value === ".." || /[/?#\\]/.test(value)) throw new Error("Invalid App-local identifier.");
  return encodeURIComponent(value);
};
const path = (args: { app: string; page?: string; block?: string }, tail: string[] = []) =>
  `/apps/runtime/${[requirePublicId(args.app, "App"), ...[args.page, args.block].filter((value): value is string => value !== undefined), ...tail].map(segment).join("/")}`;

export const publishedAppCommands = [
  command("apps runtime read", {
    summary: "Discover an authorized published page, its data, forms and available actions",
    args: appArg,
    flags: { ...paramsFlag, page: flag.string({ description: "Page ID; defaults to the published home page" }) },
    async run({ ctx, args, flags }) {
      const result = await readApi<unknown>(ctx, `${path({ ...args, page: flags.page })}${queryString(params(flags.params))}`);
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  command("apps runtime records", {
    summary: "Read one bounded records block page within its published scope",
    args: blockArgs,
    flags: {
      ...paramsFlag,
      search: flag.string({ description: "Search displayed fields" }),
      cursor: flag.string({ description: "Opaque nextCursor" }),
    },
    async run({ ctx, args, flags }) {
      const result = await readApi<unknown>(
        ctx,
        `${path(args, ["records"])}${queryString({ ...params(flags.params), _search: flags.search, _cursor: flags.cursor })}`,
      );
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  ...(
    [
      ["submit", "POST", "submit", "Submit the discovered form values"],
      ["update", "PATCH", "record", "Update the published editable fields with values and optional audit answers"],
      ["scan", "POST", "scanner", "Scan using operationId, expectedRevision, scannedText and prompt inputs"],
    ] as const
  ).map(([name, method, endpoint, summary]) =>
    command(`apps runtime ${name}`, {
      summary,
      args: blockArgs,
      flags: { ...paramsFlag, body: JSON_BODY_INPUT, yes: confirmFlag(summary) },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Pass --yes to execute the published operation.");
        const body = await readJsonInput(flags.body, "operation body");
        const result = await readApi<unknown>(
          ctx,
          `${path(args, [endpoint])}${queryString(params(flags.params))}`,
          jsonRequest(method, body),
        );
        if (!printCliStructured(ctx, result)) ctx.json(result);
      },
    }),
  ),
  command("apps runtime sidebar-submit", {
    summary: "Submit an available sidebar form",
    args: { ...appArg, action: arg.required({ description: "Sidebar action ID from runtime read" }) },
    flags: { body: JSON_BODY_INPUT, yes: confirmFlag("Submit this form") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to submit the form.");
      const result = await readApi<unknown>(
        ctx,
        path(args, ["sidebar", "forms", args.action, "submit"]),
        jsonRequest("POST", await readJsonInput(flags.body, "form values")),
      );
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  ...(["action", "row-action"] as const).map((kind) =>
    command(`apps runtime ${kind}`, {
      summary: "Run an available published action; reuse operationId when retrying",
      args: { ...blockArgs, action: arg.required({ description: "Action ID from runtime read" }) },
      flags: { ...paramsFlag, body: JSON_BODY_INPUT, yes: confirmFlag("Run this action") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Pass --yes to run the action.");
        const result = await readApi<unknown>(
          ctx,
          `${path(args, [kind === "action" ? "actions" : "row-actions", args.action])}${queryString(params(flags.params))}`,
          jsonRequest("POST", await readJsonInput(flags.body, "operationId and, for row actions, rowId/search/cursor")),
        );
        if (!printCliStructured(ctx, result)) ctx.json(result);
      },
    }),
  ),
  command("apps runtime run", {
    summary: "Read run status in the exact original published page/action scope",
    args: { ...blockArgs, run: arg.required({ description: "Run public ID returned by the operation" }) },
    flags: { ...paramsFlag, action: flag.string({ description: "Action ID; omit for a scanner run" }) },
    async run({ ctx, args, flags }) {
      const tail = flags.action ? ["actions", flags.action, "runs", args.run] : ["scanner", "runs", args.run];
      const result = await readApi<unknown>(ctx, `${path(args, tail)}${queryString(params(flags.params))}`);
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  ...(["list", "create", "update", "delete"] as const).map((verb) =>
    command(`apps runtime comments ${verb}`, {
      summary: `${verb} comments in a published comments block`,
      args: blockArgs,
      flags: {
        ...paramsFlag,
        body: JSON_BODY_INPUT,
        comment: flag.string({ description: "Comment public ID for update/delete" }),
        cursor: flag.string({ description: "Opaque nextCursor" }),
        limit: flag.int({ min: 1, max: 100, default: 20 }),
        yes: confirmFlag("Delete this comment"),
      },
      async run({ ctx, args, flags }) {
        if (verb === "delete" && !flags.yes) throw new Error("Pass --yes to delete the comment.");
        const tail = ["comments", ...(["update", "delete"].includes(verb) ? [requirePublicId(flags.comment ?? "", "Comment")] : [])];
        const endpoint = `${path(args, tail)}${queryString({ ...params(flags.params), ...(verb === "list" ? { _cursor: flags.cursor, _limit: flags.limit } : {}) })}`;
        const method = { list: "GET", create: "POST", update: "PATCH", delete: "DELETE" }[verb];
        const response = await ctx.fetch(
          `/api/grids${endpoint}`,
          jsonRequest(
            method,
            verb === "create" || verb === "update" ? await readJsonInput(flags.body, "comment object with body Markdown") : undefined,
          ),
        );
        const result: unknown = response.ok && response.status === 204 ? { deleted: true } : await ctx.readJson(response);
        if (!printCliStructured(ctx, result)) ctx.json(result);
      },
    }),
  ),
  ...(["list", "upload", "replace", "download", "delete"] as const).map((verb) =>
    command(`apps runtime files ${verb}`, {
      summary: `${verb} files in a published record block`,
      args: { ...blockArgs, field: arg.required({ description: "File field public ID from runtime read" }) },
      flags: {
        ...paramsFlag,
        id: flag.string({ description: "Existing file public ID" }),
        file: flag.string({ description: "Local upload path" }),
        out: flag.string({ description: "Download output path" }),
        yes: confirmFlag("Replace or delete this file"),
      },
      async run({ ctx, args, flags }) {
        if ((verb === "replace" || verb === "delete") && !flags.yes) throw new Error("Pass --yes to replace or delete the file.");
        const tail = [
          "record",
          "files",
          requirePublicId(args.field, "Field"),
          ...(["replace", "download", "delete"].includes(verb) ? [requirePublicId(flags.id ?? "", "File")] : []),
          ...(verb === "download" ? ["content"] : []),
        ];
        const endpoint = `${path(args, tail)}${queryString(params(flags.params))}`;
        if (verb === "download") return writeApiFile(ctx, endpoint, undefined, flags.out);
        let body: FormData | undefined;
        if (verb === "upload" || verb === "replace") {
          if (!flags.file) throw new Error("Pass --file <local path>.");
          body = new FormData();
          body.append("file", new Blob([await readFile(flags.file)]), basename(flags.file));
        }
        const response = await ctx.fetch(`/api/grids${endpoint}`, {
          method: { list: "GET", upload: "POST", replace: "PUT", delete: "DELETE" }[verb],
          body,
        });
        const result: unknown = response.ok && response.status === 204 ? { deleted: true } : await ctx.readJson(response);
        if (!printCliStructured(ctx, result)) ctx.json(result);
      },
    }),
  ),
  command("apps runtime document", {
    summary: "Download a document visible in a published record block",
    args: { ...blockArgs, document: arg.required({ description: "Document public ID from runtime read" }) },
    flags: { ...paramsFlag, out: flag.string({ description: "Local PDF output path" }) },
    async run({ ctx, args, flags }) {
      await writeApiFile(
        ctx,
        `${path(args, ["documents", requirePublicId(args.document, "Document"), "download"])}${queryString(params(flags.params))}`,
        undefined,
        flags.out,
      );
    },
  }),
  command("apps runtime image", {
    summary: "Download a card image using its signed token from a records result",
    args: { ...blockArgs, token: arg.required({ description: "Opaque token from the returned /files/<token> image URL" }) },
    flags: { ...paramsFlag, out: flag.string({ description: "Local image output path" }) },
    async run({ ctx, args, flags }) {
      await writeApiFile(ctx, `${path(args, ["files", args.token])}${queryString(params(flags.params))}`, undefined, flags.out);
    },
  }),
] as const;
