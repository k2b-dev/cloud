import { validateAppKeyAppId } from "../../app-key";
import { AppMigrationStatusSchema } from "../../contracts/app-migration";
import { command, flag, printStructured } from "../index";
import { apiGet } from "./shared";

export const appStatusCommands = [
  command("apps status", {
    summary: "Check every expected app and replica before removing infrastructure environment values",
    flags: {
      strict: flag.boolean({ description: "Return a nonzero exit code for incomplete migration (also the default)" }),
      expect: flag.string({ description: "Comma-separated operator inventory, including stopped or not-yet-started apps" }),
      allowEnv: flag.string({ description: "Explicit comma-separated exceptions for third-party apps retaining environment values" }),
    },
    async run({ ctx, flags }) {
      const query = new URLSearchParams();
      for (const [key, value] of [
        ["expect", flags.expect],
        ["allowEnv", flags.allowEnv],
      ] as const) {
        if (value)
          query.set(
            key,
            value
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(validateAppKeyAppId)
              .join(","),
          );
      }
      const result = AppMigrationStatusSchema.parse(await apiGet(ctx, `/api/admin/apps/status${query.size ? `?${query}` : ""}`));
      if (!printStructured(ctx, result)) {
        ctx.table(result.apps, [
          { key: "appId", label: "App" },
          { key: "status", label: "Mode" },
          { key: "allowedEnv", label: "Env exception" },
          { key: "needsAttention", label: "Needs attention" },
        ]);
        for (const app of result.apps)
          for (const instance of app.instances) ctx.print(`${app.appId}/${instance.instanceId}: ${instance.status}`);
        for (const issue of result.registryIssues) ctx.print(`${issue.key}: ${issue.reason}`);
      }
      return result.needsAttention ? 1 : 0;
    },
  }),
];
