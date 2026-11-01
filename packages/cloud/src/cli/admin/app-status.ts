import { validateAppKeyAppId } from "../../app-key";
import { AppMigrationStatusSchema } from "../../contracts/app-migration";
import { command, flag, printStructured } from "../index";
import { apiJson } from "./shared";

export const appStatusCommands = [
  command("apps migration observe", {
    summary: "Start legacy-use observation after upgrading every Core replica",
    async run({ ctx }) {
      const result = await apiJson(ctx, "POST", "/api/admin/apps/observation", {});
      if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result));
    },
  }),
  command("apps migration status", {
    summary: "Check every expected app and replica before removing infrastructure environment values",
    flags: {
      observationSeconds: flag.int({
        min: 1,
        description: "Required clean observation duration in seconds; choose to cover representative scheduled work",
      }),
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
      if (flags.observationSeconds !== undefined) {
        if (!Number.isSafeInteger(flags.observationSeconds) || flags.observationSeconds <= 0)
          throw new Error("--observation-seconds must be a positive integer");
        query.set("windowSeconds", String(flags.observationSeconds));
      }
      const result = AppMigrationStatusSchema.parse(
        await apiJson(ctx, "POST", `/api/admin/apps/status${query.size ? `?${query}` : ""}`, {}),
      );
      if (!printStructured(ctx, result)) {
        ctx.table(result.apps, [
          { key: "appId", label: "App" },
          { key: "status", label: "Mode" },
          { key: "allowedEnv", label: "Env exception" },
          { key: "needsAttention", label: "Needs attention" },
        ]);
        for (const app of result.apps) {
          for (const instance of app.instances) ctx.print(`${app.appId}/${instance.instanceId}: ${instance.status}`);
          for (const reason of app.attentionReasons) ctx.print(`${app.appId}: ${reason}`);
          if (app.lastRejectedStart)
            ctx.print(
              `${app.appId}: lastRejectedStart ${app.lastRejectedStart.at} · ${app.lastRejectedStart.reason} · key ${app.lastRejectedStart.keyId ?? "unknown"}`,
            );
          for (const probe of app.probes)
            ctx.print(`${app.appId}/${probe.keyId}: broker=${probe.broker}, oauth=${probe.oauth ?? "not granted"}`);
        }
        ctx.print(
          `Legacy observation: ${result.observation.complete ? "complete" : "incomplete"}, started=${result.observation.startedAt ?? "never"}, last use=${result.observation.lastLegacyUseAt ?? "none"}, window=${result.observation.windowSeconds ?? "not selected"}s`,
        );
        for (const issue of result.registryIssues) ctx.print(`${issue.key}: ${issue.reason}`);
      }
      return result.needsAttention ? 1 : 0;
    },
  }),
];
