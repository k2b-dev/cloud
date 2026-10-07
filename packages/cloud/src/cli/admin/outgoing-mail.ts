import { type AdminMailApp, type AdminMailProfile, MailProfileInputSchema } from "../../contracts/outgoing-mail";
import { arg, type CloudCliContext, command, confirmFlag, flag, readCliInput } from "../index";
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
