import {
  type AdminMailApp,
  type AdminMailProfile,
  type AdminMailRecord,
  type MailPage,
  MailProfileInputSchema,
  type MailRetention,
  MailRetentionSchema,
} from "../../contracts/outgoing-mail";
import { arg, type CloudCliContext, command, confirmFlag, flag, printStructured, readCliInput } from "../index";
import { apiGet, apiJson, printJsonOrTable } from "./shared";

const root = "/api/admin/core/outgoing-mail";
const profilePath = (key: string) => `${root}/profiles/${encodeURIComponent(key)}`;
const keyArgs = { key: arg.required({ valueLabel: "key" }) };
const print = (ctx: CloudCliContext, value: unknown) => {
  if (ctx.options.output === "json") ctx.json(value);
  else ctx.print(JSON.stringify(value, null, 2));
};
const confirmed = (yes: boolean) => {
  if (!yes) throw new Error("Outgoing mail policy changes require --yes.");
};
export const outgoingMailCommands = [
  command("outgoing-mail retention show", {
    summary: "Show outgoing mail retention in days",
    async run({ ctx }) {
      const result = await apiGet<MailRetention>(ctx, `${root}/retention`);
      if (!printStructured(ctx, result)) print(ctx, result);
    },
  }),
  command("outgoing-mail retention set", {
    summary: "Set outgoing mail content and record retention",
    flags: {
      contentDays: flag.string({ required: true, description: "Content retention in days" }),
      recordDays: flag.string({ required: true, description: "Record retention in days (at least content retention)" }),
      yes: confirmFlag("Confirm changing outgoing mail retention"),
    },
    async run({ ctx, flags }) {
      confirmed(flags.yes);
      const retention = MailRetentionSchema.parse({ contentDays: Number(flags.contentDays), recordDays: Number(flags.recordDays) });
      if (retention.recordDays < retention.contentDays) throw new Error("Record retention must be at least content retention.");
      const result = await apiJson<MailRetention>(ctx, "PUT", `${root}/retention`, retention);
      if (!printStructured(ctx, result)) print(ctx, result);
    },
  }),
  command("outgoing-mail log list", {
    summary: "List outgoing mail metadata",
    flags: {
      app: flag.string({ description: "Application ID" }),
      profile: flag.string({ description: "Sender profile key" }),
      status: flag.string({ description: "Comma-separated statuses" }),
      since: flag.string({ description: "ISO timestamp" }),
      ref: flag.string({ description: "Reference scope[:id]" }),
      recipient: flag.string({ description: "Recipient substring" }),
      cursor: flag.string({ description: "Next-page cursor" }),
      limit: flag.int({ description: "Page size (1–100)" }),
    },
    async run({ ctx, flags }) {
      if (flags.limit !== undefined && (!Number.isInteger(flags.limit) || flags.limit < 1 || flags.limit > 100))
        throw new Error("--limit must be a whole number from 1 to 100.");
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(flags)) if (value !== undefined) query.set(key, String(value));
      const result = await apiGet<MailPage<AdminMailRecord>>(ctx, `${root}/messages${query.size ? `?${query}` : ""}`);
      printJsonOrTable(ctx, result, result.items, [
        { key: "id" },
        { key: "appId" },
        { key: "profile" },
        { key: "status" },
        { key: "createdAt" },
      ]);
      if (ctx.options.output === "text" && result.nextCursor) ctx.print(`Next cursor: ${result.nextCursor}`);
    },
  }),
  command("outgoing-mail log show", {
    summary: "Read outgoing mail metadata, or audited content",
    args: { id: arg.required({ valueLabel: "id" }) },
    flags: { content: flag.boolean({ description: "Read message content (audited)" }) },
    async run({ ctx, args, flags }) {
      print(ctx, await apiGet(ctx, `${root}/messages/${encodeURIComponent(args.id)}${flags.content ? "/content" : ""}`));
    },
  }),
  command("outgoing-mail log cancel", {
    summary: "Cancel queued outgoing mail",
    args: { id: arg.optional({ valueLabel: "id" }) },
    flags: {
      batch: flag.string({ description: "Cancel queued messages in this batch instead of one ID" }),
      yes: confirmFlag("Confirm cancelling queued outgoing mail"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Cancelling outgoing mail requires --yes.");
      if ((args.id !== undefined) === (flags.batch !== undefined)) throw new Error("Choose exactly one message ID or --batch <batchId>.");
      const path = flags.batch !== undefined ? `batches/${encodeURIComponent(flags.batch)}` : `messages/${encodeURIComponent(args.id!)}`;
      print(ctx, await apiJson(ctx, "POST", `${root}/${path}/cancel`));
    },
  }),
  command("outgoing-mail profiles list", {
    summary: "List outgoing mail sender profiles",
    async run({ ctx }) {
      const result = await apiGet<{ items: AdminMailProfile[] }>(ctx, `${root}/profiles`);
      printJsonOrTable(
        ctx,
        result,
        result.items.map((p) => ({ key: p.key, name: p.name, from: p.fromAddress, default: p.isDefault, revision: p.revision })),
        [{ key: "key" }, { key: "name" }, { key: "from" }, { key: "default" }, { key: "revision" }],
      );
    },
  }),
  command("outgoing-mail profiles get", {
    summary: "Read one outgoing mail sender profile",
    args: keyArgs,
    async run({ ctx, args }) {
      print(ctx, await apiGet(ctx, profilePath(args.key)));
    },
  }),
  command("outgoing-mail profiles put", {
    summary: "Create or replace a sender profile with its current revision",
    args: keyArgs,
    flags: { config: flag.input({ required: true, description: "Profile JSON; SMTP passwords only via --config-file or --stdin" }) },
    async run({ ctx, args, flags }) {
      const input = await readCliInput(flags.config, { label: "outgoing mail profile", required: true });
      let raw: unknown;
      try {
        raw = JSON.parse(input ?? "");
      } catch {
        throw new Error("Invalid outgoing mail profile JSON.");
      }
      if (flags.config.source === "value" && raw && typeof raw === "object" && "smtpPassword" in raw)
        throw new Error("Pass smtpPassword only through --config-file or --stdin.");
      print(ctx, await apiJson(ctx, "PUT", profilePath(args.key), MailProfileInputSchema.parse(raw)));
    },
  }),
  command("outgoing-mail profiles set-default", {
    summary: "Choose the default outgoing mail sender",
    args: keyArgs,
    flags: { yes: confirmFlag("Confirm changing the default sender") },
    async run({ ctx, args, flags }) {
      confirmed(flags.yes);
      print(ctx, await apiJson(ctx, "POST", `${profilePath(args.key)}/default`));
    },
  }),
  command("outgoing-mail profiles delete", {
    summary: "Delete a sender profile that is not the default",
    args: keyArgs,
    flags: { yes: confirmFlag("Confirm deleting the sender profile") },
    async run({ ctx, args, flags }) {
      confirmed(flags.yes);
      const response = await ctx.fetch(profilePath(args.key), { method: "DELETE" });
      if (!response.ok) await ctx.readJson(response);
      print(ctx, { deleted: args.key });
    },
  }),
  command("outgoing-mail profiles test", {
    summary: "Send a test email through a sender profile",
    args: keyArgs,
    flags: { to: flag.string({ required: true, description: "Recipient email address" }) },
    async run({ ctx, args, flags }) {
      print(ctx, await apiJson(ctx, "POST", `${profilePath(args.key)}/test`, { recipient: flags.to }));
    },
  }),
  command("outgoing-mail apps list", {
    summary: "List application outgoing mail permissions and profile access",
    async run({ ctx }) {
      const result = await apiGet<{ defaultProfile: string | null; items: AdminMailApp[] }>(ctx, `${root}/apps`);
      printJsonOrTable(
        ctx,
        result,
        result.items.map((app) => ({ ...app, profiles: app.profiles.join(",") })),
        [{ key: "appId" }, { key: "name" }, { key: "declared" }, { key: "mode" }, { key: "profiles" }],
      );
    },
  }),
  command("outgoing-mail apps set", {
    summary: "Set default, selected, or blocked outgoing mail access",
    args: { app: arg.required({ valueLabel: "app" }) },
    flags: {
      default: flag.boolean({ description: "Use the default sender" }),
      profiles: flag.string({ description: "Comma-separated profile keys" }),
      none: flag.boolean({ description: "Block sending with an empty selected list" }),
      yes: confirmFlag("Confirm application outgoing mail access change"),
    },
    async run({ ctx, args, flags }) {
      confirmed(flags.yes);
      if ([flags.default, flags.none, flags.profiles !== undefined].filter(Boolean).length !== 1)
        throw new Error("Choose exactly one of --default, --profiles or --none.");
      const profiles = flags.profiles?.split(",").map((key) => key.trim());
      if (profiles?.some((key) => !key)) throw new Error("--profiles requires non-empty profile keys; use --none to block sending.");
      print(
        ctx,
        await apiJson(
          ctx,
          "PUT",
          `${root}/apps/${encodeURIComponent(args.app)}`,
          flags.default ? { mode: "default" } : { mode: "selected", profiles: profiles ?? [] },
        ),
      );
    },
  }),
];
