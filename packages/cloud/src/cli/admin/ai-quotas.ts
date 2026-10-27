import type { AiModelPricing } from "../../shared/ai-costs";

import {
  type AiQuotaConfig,
  AiQuotaConfigSchema,
  type AiQuotaIdentity,
  AiQuotaIdentitySchema,
  AiQuotaReportQuerySchema,
  AiQuotaResetSchema,
} from "../../shared/ai-quotas";
import { type CloudCliContext, cliText, command, confirmFlag, flag, printRows, printStructured } from "../index";
import { apiGet, apiJson, queryString, readJsonInput } from "./shared";

const path = "/api/admin/core/ai-quotas";
const identity = {
  type: flag.enum(["user", "service_account"] as const, { default: "user", description: "Identity type" }),
  id: flag.string({ required: true, description: "Identity UUID from users" }),
};
const print = (ctx: CloudCliContext, value: unknown) => {
  if (!printStructured(ctx, value)) ctx.print(JSON.stringify(value, null, 2));
};
const confirm = (ctx: CloudCliContext, yes: boolean) => {
  if (!yes) throw new Error(cliText(ctx, { en: "Quota changes require --yes.", de: "Kontingentänderungen erfordern --yes." }));
};

export const aiQuotaCommands = [
  command("ai quotas background status", {
    summary: "Show rolling 24-hour background costs and emergency-stop state",
    async run({ ctx }) {
      print(ctx, await apiGet(ctx, `${path}/background`));
    },
  }),
  command("ai quotas background release", {
    summary: "Release the background emergency stop after reviewing costs",
    flags: { yes: confirmFlag("Confirm release of the background AI emergency stop") },
    async run({ ctx, flags }) {
      confirm(ctx, flags.yes);
      print(ctx, await apiJson(ctx, "POST", `${path}/background/release`, {}));
    },
  }),
  command("ai quotas config get", {
    summary: "Export Assistant limits, rules and revision (platform admin)",
    async run({ ctx }) {
      print(ctx, await apiGet<AiQuotaConfig>(ctx, path));
    },
  }),
  command("ai quotas config set", {
    summary: "Replace Assistant quota configuration using its current revision",
    flags: {
      config: flag.input({ required: true, description: "Complete configuration JSON: --config, --config-file or --stdin" }),
      yes: confirmFlag("Confirm replacement of Assistant quota configuration"),
    },
    async run({ ctx, flags }) {
      confirm(ctx, flags.yes);
      const config = AiQuotaConfigSchema.parse(await readJsonInput<unknown>(flags.config, "quota configuration"));
      print(ctx, await apiJson<AiQuotaConfig>(ctx, "PUT", path, config));
    },
  }),
  command("ai quotas models", {
    summary: "List configured models; only priced chat models support cost rules",
    async run({ ctx }) {
      const result = await apiGet<{ models: { id: string; label: string; pricing?: AiModelPricing }[] }>(ctx, `${path}/models`);
      printRows(
        ctx,
        result,
        result.models.map((model) => ({ ...model, pricing: model.pricing ? JSON.stringify(model.pricing) : "unpriced" })),
        [{ key: "id" }, { key: "label" }, { key: "pricing" }],
      );
    },
  }),
  command("ai quotas report", {
    summary: "Report chat costs and current allowances with the same filters as the admin page",
    flags: {
      range: flag.enum(["24h", "7d", "30d", "90d"] as const, { default: "30d" }),
      until: flag.string({ description: "ISO period end; reuse query.until for consistent pagination" }),
      search: flag.string({ description: "Search identity labels" }),
      model: flag.string({ description: "Model ID" }),
      status: flag.enum(["all", "available", "exhausted", "unknown", "unlimited", "disabled"] as const, { default: "all" }),
      sort: flag.enum(["label", "cost", "lastUsed"] as const, { default: "lastUsed" }),
      direction: flag.enum(["asc", "desc"] as const, { default: "desc" }),
      page: flag.int({ min: 1, max: 1_000_000, default: 1 }),
      identity: flag.string({ description: "Optional selected identity UUID" }),
      identityType: flag.enum(["user", "service_account"] as const, { default: "user" }),
    },
    async run({ ctx, flags }) {
      const query = AiQuotaReportQuerySchema.parse(flags);
      print(ctx, await apiGet(ctx, `${path}/report${queryString(query)}`));
    },
  }),
  command("ai quotas users", {
    summary: "List chat users; search also finds identities without prior usage",
    flags: {
      search: flag.string({ description: "Search identity labels" }),
      page: flag.int({ min: 1, default: 1 }),
    },
    async run({ ctx, flags }) {
      const result = await apiGet<{ items: AiQuotaIdentity[]; total: number; page: number; perPage: number }>(
        ctx,
        `${path}/users${queryString(flags)}`,
      );
      printRows(ctx, result, result.items, [{ key: "id" }, { key: "type" }, { key: "label" }, { key: "lastUsed" }]);
      if (ctx.options.output === "text")
        ctx.print(
          cliText(ctx, {
            en: `Page ${result.page}; ${result.total} identities.`,
            de: `Seite ${result.page}; ${result.total} Identitäten.`,
          }),
        );
    },
  }),
  command("ai quotas balance", {
    summary: "Show one identity's effective limits, usage and reset times",
    flags: identity,
    async run({ ctx, flags }) {
      const subject = AiQuotaIdentitySchema.parse(flags);
      print(ctx, await apiGet(ctx, `${path}/balance${queryString(subject)}`));
    },
  }),
  command("ai quotas reset", {
    summary: "Reset one identity and quota scope; reuse request ID when retrying",
    flags: {
      ...identity,
      scope: flag.string({ required: true, description: "Model ID or * (quote the wildcard)" }),
      requestId: flag.string({ required: true, description: "UUID for this reset; reuse for retries, use a new UUID for a new reset" }),
      yes: confirmFlag("Confirm reset of this identity and quota scope"),
    },
    async run({ ctx, flags }) {
      confirm(ctx, flags.yes);
      const { yes: _yes, ...input } = flags;
      const reset = AiQuotaResetSchema.parse(input);
      print(ctx, await apiJson(ctx, "POST", `${path}/reset`, reset));
    },
  }),
];
