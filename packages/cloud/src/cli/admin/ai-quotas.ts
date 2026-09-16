import { AiModelPricingSchema, type AiModelPricing } from "../../shared/ai-costs";
import {
  AiQuotaConfigSchema,
  AiQuotaIdentitySchema,
  AiQuotaResetSchema,
  type AiQuotaConfig,
  type AiQuotaIdentity,
} from "../../shared/ai-quotas";
import { cliText, command, confirmFlag, flag, printRows, printStructured, type CloudCliContext } from "../index";
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
  command("ai models pricing get", {
    summary: "List configured model input/output reference prices per million tokens",
    async run({ ctx }) {
      print(ctx, await apiGet(ctx, `${path}/models`));
    },
  }),
  command("ai models pricing set", {
    summary: "Set one model's reference prices; JSON null removes prices and makes it unlimited",
    flags: {
      id: flag.string({ required: true, description: "Model profile ID" }),
      pricing: flag.input({
        required: true,
        description: "{inputPerMillion,outputPerMillion} or null: --pricing, --pricing-file or --stdin",
      }),
      yes: confirmFlag("Confirm model price change"),
    },
    async run({ ctx, flags }) {
      confirm(ctx, flags.yes);
      const pricing = AiModelPricingSchema.nullable().parse(await readJsonInput<unknown>(flags.pricing, "model pricing"));
      const current = await apiGet<{ models: { id: string; pricing?: AiModelPricing }[] }>(ctx, `${path}/models`);
      const model = current.models.find((model) => model.id === flags.id);
      if (!model) throw new Error("Model not found.");
      print(
        ctx,
        await apiJson(ctx, "PUT", `${path}/models/${encodeURIComponent(flags.id!)}/pricing`, { pricing, expected: model.pricing ?? null }),
      );
    },
  }),
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
    summary: "List configured model profiles; only priced chat models support cost rules",
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
      scope: flag.string({ required: true, description: "Model profile ID or * (quote the wildcard)" }),
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
