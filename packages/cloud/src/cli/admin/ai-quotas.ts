import { AiQuotaConfigSchema, AiQuotaIdentitySchema, AiQuotaResetSchema, type AiQuotaConfig, type AiQuotaIdentity } from "../../shared/ai-quotas";
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
    summary: "List model profile IDs available for quota rules; use * for all chat models",
    async run({ ctx }) {
      const result = await apiGet<{ models: { id: string; label: string }[] }>(ctx, `${path}/models`);
      printRows(ctx, result, result.models, [{ key: "id" }, { key: "label" }]);
    },
  }),
  command("ai quotas users", {
    summary: "List chat users; search also finds identities without prior usage",
    flags: {
      search: flag.string({ description: "Search identity labels" }),
      page: flag.int({ min: 1, default: 1 }),
    },
    async run({ ctx, flags }) {
      const result = await apiGet<{ items: AiQuotaIdentity[]; total: number; page: number; perPage: number }>(ctx, `${path}/users${queryString(flags)}`);
      printRows(ctx, result, result.items, [{ key: "id" }, { key: "type" }, { key: "label" }, { key: "lastUsed" }]);
      if (ctx.options.output === "text") ctx.print(cliText(ctx, {
        en: `Page ${result.page}; ${result.total} identities.`,
        de: `Seite ${result.page}; ${result.total} Identitäten.`,
      }));
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
