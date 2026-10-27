import { z } from "zod";
import { AiModelAccessDraftSchema } from "../../ai/model-access";
import {
  AI_MODEL_SLOTS,
  AiDeleteModelSchema,
  AiModelInputSchema,
  AiModelPatchSchema,
  AiProviderInputSchema,
  AiProviderPatchSchema,
  AiVariantInputSchema,
  AiVariantPatchSchema,
} from "../../shared/ai-models";
import { arg, type CloudCliContext, command, confirmFlag, flag, printStructured, readCliInput } from "../index";
import { apiGet, apiJson, readJsonInput } from "./shared";

const base = "/api/admin/core/ai";
const print = (ctx: CloudCliContext, result: unknown) => {
  if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
};
const confirm = (yes: boolean) => {
  if (!yes) throw new Error("AI configuration changes require --yes.");
};
const id = { id: arg.required({ valueLabel: "id" }) };
const input = flag.input({ required: true, description: "JSON input: --input, --input-file or --stdin" });
const yes = confirmFlag("Confirm AI configuration change");
const endpoint = (area: string, id: string) => `${base}/${area}/${encodeURIComponent(id)}`;
export const aiModelCommands = [
  command("ai providers list", {
    summary: "List provider connections and their status",
    async run({ ctx }) {
      print(ctx, await apiGet(ctx, `${base}/providers`));
    },
  }),
  command("ai providers show", {
    summary: "Show a provider; credential and header values stay private",
    args: id,
    async run({ ctx, args }) {
      print(ctx, await apiGet(ctx, endpoint("providers", args.id)));
    },
  }),
  command("ai providers add", {
    summary: "Create a provider connection",
    flags: { input, yes },
    async run({ ctx, flags }) {
      confirm(flags.yes);
      print(
        ctx,
        await apiJson(ctx, "POST", `${base}/providers`, AiProviderInputSchema.parse(await readJsonInput<unknown>(flags.input, "provider"))),
      );
    },
  }),
  command("ai providers update", {
    summary: "Update a provider with optimistic concurrency",
    args: id,
    flags: { input, yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      const patch = AiProviderPatchSchema.parse(await readJsonInput<unknown>(flags.input, "provider patch"));
      const current = await apiGet<{ revision: number }>(ctx, endpoint("providers", args.id));
      print(ctx, await apiJson(ctx, "PATCH", endpoint("providers", args.id), { ...patch, revision: current.revision }));
    },
  }),
  command("ai providers test", {
    summary: "Test a saved provider connection (10 second timeout)",
    args: id,
    async run({ ctx, args }) {
      print(ctx, await apiJson(ctx, "POST", `${endpoint("providers", args.id)}/test`, {}));
    },
  }),
  command("ai providers key", {
    summary: "Replace a provider key from protected input",
    args: id,
    flags: { key: flag.input({ required: true, description: "API key: use --key-file or --stdin" }), yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      const apiKey = await readCliInput(flags.key, { required: true, label: "API key" });
      const current = await apiGet<{ revision: number }>(ctx, endpoint("providers", args.id));
      print(
        ctx,
        await apiJson(ctx, "PUT", `${endpoint("providers", args.id)}/credential`, {
          apiKey: apiKey?.trim() ?? "",
          revision: current.revision,
        }),
      );
    },
  }),
  command("ai providers models", {
    summary: "List the models advertised by a provider",
    args: id,
    async run({ ctx, args }) {
      print(ctx, await apiGet(ctx, `${endpoint("providers", args.id)}/available-models`));
    },
  }),
  command("ai models list", {
    summary: "List configured models",
    async run({ ctx }) {
      print(ctx, await apiGet(ctx, `${base}/models`));
    },
  }),
  command("ai models show", {
    summary: "Show a model, variants and access",
    args: id,
    async run({ ctx, args }) {
      print(ctx, await apiGet(ctx, endpoint("models", args.id)));
    },
  }),
  command("ai models add", {
    summary: "Add a model to a provider",
    args: { provider: arg.required() },
    flags: { input, yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      const data = z
        .union([AiModelInputSchema, z.array(AiModelInputSchema).min(1)])
        .parse(await readJsonInput<unknown>(flags.input, "models"));
      print(ctx, await apiJson(ctx, "POST", `${endpoint("providers", args.provider)}/models`, data));
    },
  }),
  command("ai models update", {
    summary: "Update one model and its shared prices",
    args: id,
    flags: { input, yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      const data = AiModelPatchSchema.extend({ access: AiModelAccessDraftSchema.optional() }).parse(
        await readJsonInput<unknown>(flags.input, "model patch"),
      );
      const current = await apiGet<{ revision: number }>(ctx, endpoint("models", args.id));
      print(ctx, await apiJson(ctx, "PATCH", endpoint("models", args.id), { ...data, revision: current.revision }));
    },
  }),
  command("ai variants add", {
    summary: "Create a named model variant",
    args: { model: arg.required() },
    flags: { input, yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      print(
        ctx,
        await apiJson(
          ctx,
          "POST",
          `${endpoint("models", args.model)}/variants`,
          AiVariantInputSchema.parse(await readJsonInput<unknown>(flags.input, "variant")),
        ),
      );
    },
  }),
  command("ai variants update", {
    summary: "Update a variant's overrides",
    args: id,
    flags: { input, yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      const data = AiVariantPatchSchema.parse(await readJsonInput<unknown>(flags.input, "variant patch"));
      const current = await apiGet<{ variants: { id: string; revision: number }[] }>(ctx, endpoint("models", args.id.split(":")[0]!));
      const variant = current.variants.find((v) => v.id === args.id);
      if (!variant) throw new Error("Variant not found.");
      print(ctx, await apiJson(ctx, "PATCH", endpoint("variants", args.id), { ...data, revision: variant.revision }));
    },
  }),
  ...(["providers", "models", "variants"] as const).map((area) =>
    command(`ai ${area} delete`, {
      summary: "Delete with explicit assignment replacements and retargeting choice",
      args: id,
      flags: { input, yes },
      async run({ ctx, args, flags }) {
        confirm(flags.yes);
        const data = AiDeleteModelSchema.parse(await readJsonInput<unknown>(flags.input, "delete consequences"));
        print(ctx, await apiJson(ctx, "DELETE", endpoint(area, args.id), data));
      },
    }),
  ),
  command("ai classes show", {
    summary: "Show class and tool assignments, fallback chains and recent callers",
    async run({ ctx }) {
      print(ctx, await apiGet(ctx, `${base}/assignments`));
    },
  }),
  command("ai classes set", {
    summary: "Assign a class or tool slot to a variant or none",
    args: { slot: arg.required(), variant: arg.required() },
    flags: { yes },
    async run({ ctx, args, flags }) {
      confirm(flags.yes);
      const slot = z.enum(AI_MODEL_SLOTS).parse(args.slot);
      const current = await apiGet<{ assignments: { slot: string; revision: number }[] }>(ctx, `${base}/assignments`);
      const assignment = current.assignments.find((a) => a.slot === slot);
      if (!assignment) throw new Error("Assignment missing.");
      print(
        ctx,
        await apiJson(ctx, "PUT", `${base}/assignments/${slot}`, {
          variantId: args.variant === "none" ? null : args.variant,
          revision: assignment.revision,
        }),
      );
    },
  }),
];
