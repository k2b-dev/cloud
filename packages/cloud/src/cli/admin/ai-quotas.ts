import { type AiModelPricing, AiModelPricingSchema } from "../../shared/ai-costs";
import {
  type AiModelRequestSettings,
  AiModelRequestSettingsSchema,
  AiModelRequestSettingsUpdateSchema,
} from "../../shared/ai-model-request-settings";
import {
  type AiQuotaConfig,
  AiQuotaConfigSchema,
  type AiQuotaIdentity,
  AiQuotaIdentitySchema,
  AiQuotaReportQuerySchema,
  AiQuotaResetSchema,
} from "../../shared/ai-quotas";
import { type CloudCliContext, cliText, command, confirmFlag, flag, printRows, printStructured, readCliInput } from "../index";
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
  command("ai models settings get", {
    summary: "Read model thinking level, extra parameters and configured header names",
    flags: { id: flag.string({ required: true, description: "Model profile ID" }) },
    async run({ ctx, flags }) {
      print(ctx, AiModelRequestSettingsSchema.parse(await apiGet(ctx, `${path}/models/${encodeURIComponent(flags.id!)}/settings`)));
    },
  }),
  command("ai models settings set", {
    summary: "Patch one model's request settings; header values are write-only",
    flags: {
      id: flag.string({ required: true, description: "Model profile ID" }),
      thinkingLevel: flag.string({ name: "thinking-level", description: "Provider-specific thinking level" }),
      clearThinkingLevel: flag.boolean({ name: "clear-thinking-level", description: "Use the model's default thinking level" }),
      extraBody: flag.input({ name: "extra-body", description: "Extra parameters JSON: --extra-body, --extra-body-file or --stdin" }),
      clearExtraBody: flag.boolean({ name: "clear-extra-body", description: "Remove extra parameters" }),
      headers: flag.input({
        stdinName: "headers-stdin",
        description: "Header patch JSON; use --headers-file or --headers-stdin for secrets",
      }),
      clearHeaders: flag.boolean({ name: "clear-headers", description: "Remove all configured extra headers before applying the patch" }),
      yes: confirmFlag("Confirm model request settings change"),
    },
    async run({ ctx, flags }) {
      if (!flags.yes) throw new Error("Model request settings changes require --yes.");
      if (flags.thinkingLevel !== undefined && flags.clearThinkingLevel)
        throw new Error("Choose --thinking-level or --clear-thinking-level.");
      if (flags.extraBody.provided && flags.clearExtraBody) throw new Error("Choose --extra-body or --clear-extra-body.");
      if (
        !flags.extraBody.provided &&
        !flags.headers.provided &&
        flags.thinkingLevel === undefined &&
        !flags.clearThinkingLevel &&
        !flags.clearExtraBody &&
        !flags.clearHeaders
      )
        throw new Error("Select at least one model request setting to change.");
      if (flags.extraBody.source === "stdin" && flags.headers.source === "stdin")
        throw new Error("Read one JSON input from stdin and supply the other from a file.");
      const parseInput = async (input: typeof flags.headers, label: string): Promise<unknown> => {
        const raw = await readCliInput(input, { required: true, label });
        try {
          return JSON.parse(raw!);
        } catch {
          throw new Error(`Invalid ${label} JSON.`);
        }
      };
      const patch: Record<string, unknown> = {};
      if (flags.thinkingLevel !== undefined || flags.clearThinkingLevel)
        patch.reasoningEffort = flags.clearThinkingLevel ? null : flags.thinkingLevel;
      if (flags.extraBody.provided || flags.clearExtraBody)
        patch.extraBody = flags.clearExtraBody ? null : await parseInput(flags.extraBody, "extra parameters");
      if (flags.headers.provided) patch.requestHeaders = await parseInput(flags.headers, "extra headers");
      if (flags.clearHeaders) patch.clearRequestHeaders = true;
      // Validate locally before reading the current revision or sending secrets.
      const valid = AiModelRequestSettingsUpdateSchema.parse({ ...patch, expected: "pending" });
      const current = await apiGet<AiModelRequestSettings>(ctx, `${path}/models/${encodeURIComponent(flags.id!)}/settings`);
      print(
        ctx,
        AiModelRequestSettingsSchema.parse(
          await apiJson(ctx, "PUT", `${path}/models/${encodeURIComponent(flags.id!)}/settings`, { ...valid, expected: current.revision }),
        ),
      );
    },
  }),
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
  command("ai quotas report", {
    summary: "Report chat costs and current allowances with the same filters as the admin page",
    flags: {
      range: flag.enum(["24h", "7d", "30d", "90d"] as const, { default: "30d" }),
      until: flag.string({ description: "ISO period end; reuse query.until for consistent pagination" }),
      search: flag.string({ description: "Search identity labels" }),
      model: flag.string({ description: "Model profile ID" }),
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
