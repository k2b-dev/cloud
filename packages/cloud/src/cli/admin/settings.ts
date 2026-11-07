import { AdminSettingsCatalogSchema } from "../../contracts/admin-settings";
import { EnvSettingsStatusSchema } from "../../contracts/settings-env";
import { arg, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet, apiJson } from "./shared";

// These are the owning APIs: cron changes and other app-owned hooks must run there.
export const APP_SETTING_PATHS: Readonly<Record<string, string>> = {
  "gateway-ops": "/api/gateway/settings/",
  mail: "/api/mail/admin/settings/",
  notebooks: "/api/notebooks/admin/settings/",
  grids: "/api/grids/admin/settings/",
  chat: "/api/chat/admin/settings/",
};
const catalog = async (ctx: Parameters<typeof apiGet>[0], app?: string) =>
  AdminSettingsCatalogSchema.parse(
    await apiGet(ctx, `/api/admin/core/settings/env/catalog${app ? `?app=${encodeURIComponent(app)}` : ""}`),
  );

export const settingsCommands = [
  command("retention show", {
    summary: "Read log, request-event and rollup retention",
    async run({ ctx }) {
      const [logs, settings] = await Promise.all([
        apiGet(ctx, "/api/logging/settings/retention"),
        apiGet<{ key: string; value: unknown; unreadable: boolean }[]>(ctx, "/api/gateway/settings"),
      ]);
      const setting = (key: string) => {
        const row = settings.find((item) => item.key === key);
        if (!row) throw new Error("Retention setting unavailable.");
        return { days: row.value, unreadable: row.unreadable };
      };
      const result = {
        logs,
        events: setting("gateway.telemetry_event_retention_days"),
        rollups: setting("gateway.telemetry_rollup_retention_days"),
      };
      if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
    },
  }),
  command("settings list", {
    summary: "List administrator setting keys, types and presence without values",
    flags: { app: flag.string({ description: "Owning application ID; omit for platform settings" }) },
    async run({ ctx, flags }) {
      const result = await catalog(ctx, flags.app);
      if (!printStructured(ctx, result))
        ctx.table(
          result.settings,
          ["key", "kind", "stored", "storedValuePresent", "envBacked"].map((key) => ({ key })),
        );
    },
  }),
  command("settings show", {
    summary: "Show one setting's status and presence without values",
    args: { key: arg.required() },
    flags: { app: flag.string({ description: "Owning application ID" }) },
    async run({ ctx, args, flags }) {
      const setting = (await catalog(ctx, flags.app)).settings.find((item) => item.key === args.key);
      if (!setting) throw new Error("Unknown setting in this application.");
      if (!printStructured(ctx, setting))
        ctx.table(
          [setting],
          ["key", "kind", "stored", "storedValuePresent"].map((key) => ({ key })),
        );
    },
  }),
  command("settings status", {
    summary: "Check environment-backed settings across registered processes without printing values",
    flags: { env: flag.boolean({ description: "Check stored values against each running application's environment" }) },
    async run({ ctx, flags }) {
      if (!flags.env) throw new Error("Use settings status --env.");
      const result = EnvSettingsStatusSchema.parse(await apiGet(ctx, "/api/admin/core/settings/env/status"));
      if (!printStructured(ctx, result)) {
        for (const process of result.processes) {
          ctx.print(`${process.appId}: ${process.status}`);
          ctx.table(
            process.settings,
            [
              "key",
              "envVariable",
              "storedValuePresent",
              "envValuePresent",
              "conflict",
              "unreadableStoredValue",
              "invalidEnvValue",
              "needsAttention",
            ].map((key) => ({ key })),
          );
        }
      }
      return result.needsAttention ? 1 : 0;
    },
  }),
  command("settings set", {
    summary: "Set a whole administrator setting value",
    args: { key: arg.required() },
    flags: {
      value: flag.string({ description: "Non-secret JSON value; use --from for credentials or sensitive configuration" }),
      from: flag.string({ description: "Read a JSON value from a file, or - for stdin; required for secrets" }),
      app: flag.string({ description: "Owning application ID; omit for platform settings" }),
      replaceUnreadable: flag.boolean({ description: "Explicitly replace an unreadable stored row with this whole value" }),
      yes: confirmFlag("Confirm setting change"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Setting changes require --yes.");
      if ((flags.value === undefined) === (flags.from === undefined)) throw new Error("Provide exactly one of --value or --from <file|->.");
      const setting = (await catalog(ctx, flags.app)).settings.find((item) => item.key === args.key);
      if (!setting) throw new Error("Unknown setting in this application.");
      if (setting.kind === "secret" && flags.value !== undefined) throw new Error("Secret values require --from <file|->.");
      const raw = flags.from === "-" ? await Bun.stdin.text() : flags.from ? await Bun.file(flags.from).text() : flags.value;
      let value: unknown;
      try {
        value = JSON.parse(raw ?? "");
      } catch {
        throw new Error("Setting input must be valid JSON.");
      }
      const ownerPath = flags.app && APP_SETTING_PATHS[flags.app];
      const body = { value, replaceUnreadable: flags.replaceUnreadable };
      await (ownerPath
        ? apiJson(ctx, "PUT", `${ownerPath}${encodeURIComponent(args.key)}`, body)
        : flags.app && flags.app !== "core"
          ? apiJson(ctx, "PUT", `/api/admin/core/settings/env/${encodeURIComponent(flags.app)}/${encodeURIComponent(args.key)}`, body)
          : apiJson(ctx, "PUT", "/api/admin/core/settings", {
              updates: { [args.key]: value },
              replaceUnreadable: flags.replaceUnreadable ? [args.key] : [],
            }));
      if (!printStructured(ctx, { saved: true })) ctx.print("Setting saved.");
    },
  }),
];
