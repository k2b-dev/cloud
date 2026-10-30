import { EnvSettingsStatusSchema } from "../../contracts/settings-env";
import { arg, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet, apiJson } from "./shared";

export const settingsCommands = [
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
      value: flag.string({ required: true, description: "JSON value (quote a text value as JSON)" }),
      app: flag.string({ description: "Owning application ID; omit for platform settings" }),
      replaceUnreadable: flag.boolean({ description: "Explicitly replace an unreadable stored row with this whole value" }),
      yes: confirmFlag("Confirm setting change"),
    },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Setting changes require --yes.");
      let value: unknown;
      try {
        value = JSON.parse(flags.value ?? "");
      } catch {
        throw new Error("--value must be valid JSON.");
      }
      const result = flags.app
        ? await apiJson(ctx, "PUT", `/api/admin/core/settings/env/${encodeURIComponent(flags.app)}/${encodeURIComponent(args.key)}`, {
            value,
            replaceUnreadable: flags.replaceUnreadable,
          })
        : await apiJson(ctx, "PUT", "/api/admin/core/settings", {
            updates: { [args.key]: value },
            replaceUnreadable: flags.replaceUnreadable ? [args.key] : [],
          });
      if (!printStructured(ctx, result)) ctx.print("Setting saved.");
    },
  }),
];
