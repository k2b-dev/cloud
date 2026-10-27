import { sql } from "bun";
import { z } from "zod";
import { ConfigConflict } from "../services/config-conflict";
import { stripImageDataUrlMetadata } from "../services/image-metadata";
import {
  AI_MODEL_CLASSES,
  AiAssignmentSchema,
  type AiModel,
  AiModelInputSchema,
  AiModelSchema,
  type AiModelVariant,
  type AiProvider,
  AiProviderInputSchema,
  AiProviderSchema,
  AiVariantInputSchema,
  AiVariantSchema,
  aiModelClassFallbackChain,
} from "../shared/ai-models";
import { listAiCredentialProviderIds } from "./credentials";
import { AiModelAccessConflict, type AiModelAccessDraft, aiModelAccess } from "./model-access";
import { getAiRequestHeaders } from "./request-headers";
import type { AiModelProfile } from "./types";

export const lockAiModelCatalog = async (db = sql) => {
  await db`SELECT pg_advisory_xact_lock(hashtext('ai.catalog'))`;
};

type Table = "providers" | "models" | "model_variants" | "model_assignments";
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const decode = (value: unknown) =>
  Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(value)).map(([key, entry]) => [camel(key), entry]));
const jsonColumns = new Set(["capabilities", "icon", "pricing", "extraBody"]);
const parameter = (value: unknown): string | number | boolean | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
};
export class AiConfigError extends Error {
  constructor(
    readonly code: "model_not_found" | "invalid_configuration",
    message: string,
  ) {
    super(message);
  }
}
export const assertAiRevision = async (
  current: { revision: number; updatedBy: string | null; updatedAt: string },
  revision: number,
  db = sql,
) => {
  if (current.revision === revision) return;
  const [who] = current.updatedBy
    ? await db<
        { id: string; name: string }[]
      >`SELECT id, COALESCE(NULLIF(display_name,''),uid) AS name FROM auth.users WHERE id=${current.updatedBy}::uuid`
    : [];
  throw new ConfigConflict(current, who ?? null, current.updatedAt);
};
const rows = async (table: Table, id?: string, db = sql, lock = false) => {
  const key = table === "model_assignments" ? "slot" : "id";
  const result = await db.unsafe<{ data: unknown }[]>(
    `SELECT to_jsonb(t) AS data FROM ai.${table} t${id === undefined ? "" : ` WHERE ${key}=$1`}${lock ? " FOR UPDATE" : ""}`,
    id === undefined ? [] : [id],
  );
  return result.map((row) => decode(row.data));
};
const write = async (table: Table, value: Record<string, unknown>, actorId: string, db = sql, id?: string) => {
  const entries = Object.entries(value).filter(([, value]) => value !== undefined);
  const columns = entries.map(([key]) => snake(key));
  const values = entries.map(([key], index) => `$${index + 1}${jsonColumns.has(key) ? "::jsonb" : ""}`);
  const params = entries.map(([, value]) => parameter(value));
  if (id === undefined) {
    await db.unsafe(`INSERT INTO ai.${table} (${columns.join(",")},updated_by) VALUES (${values.join(",")},$${params.length + 1}::uuid)`, [
      ...params,
      actorId,
    ]);
  } else {
    await db.unsafe(
      `UPDATE ai.${table} SET ${columns.map((key, index) => `${key}=${values[index]}`).join(",")}, revision=revision+1,updated_at=clock_timestamp(),updated_by=$${params.length + 1}::uuid WHERE ${table === "model_assignments" ? "slot" : "id"}=$${params.length + 2}`,
      [...params, actorId, id],
    );
  }
};
const requireRow = <T>(value: T | undefined): T => {
  if (!value) throw new AiConfigError("model_not_found", "Model or provider no longer exists.");
  return value;
};
const presentProvider = async (value: Record<string, unknown>, db = sql, credentialIds?: string[]): Promise<AiProvider> => {
  const id = z.string().parse(value.id);
  return AiProviderSchema.parse({
    ...value,
    credentialSet: (credentialIds ?? (await listAiCredentialProviderIds(db))).includes(id),
    requestHeaderNames: Object.keys(await getAiRequestHeaders(id, db)).sort(),
  });
};
const validateProvider = (provider: z.infer<typeof AiProviderInputSchema>) => {
  if (provider.type === "openai-compatible" && !provider.baseUrl)
    throw new AiConfigError("invalid_configuration", "OpenAI-compatible providers require a base URL.");
};
const sanitizeModel = (model: z.infer<typeof AiModelInputSchema>) => ({
  ...model,
  icon: model.icon.kind === "image" ? { ...model.icon, dataUrl: stripImageDataUrlMetadata(model.icon.dataUrl) } : model.icon,
});
const validateModel = (model: z.infer<typeof AiModelInputSchema>, provider: AiProvider) => {
  if (
    model.kind === "transcription" &&
    (!["openai", "openai-compatible"].includes(provider.type) ||
      model.pricing ||
      model.extraBody ||
      model.capabilities.some((value) => value !== "transcription"))
  )
    throw new AiConfigError(
      "invalid_configuration",
      "Transcription requires an OpenAI-compatible provider and cannot have chat capabilities, parameters or token prices.",
    );
  if (model.kind === "chat" && model.capabilities.includes("transcription"))
    throw new AiConfigError("invalid_configuration", "Chat models cannot transcribe audio.");
};
export const aiModelCatalog = {
  async providers(db = sql, admin = true) {
    const [values, credentialIds] = await Promise.all([rows("providers", undefined, db), listAiCredentialProviderIds(db)]);
    return Promise.all(
      values.map((row) =>
        admin
          ? presentProvider(row, db, credentialIds)
          : AiProviderSchema.parse({ ...row, credentialSet: credentialIds.includes(z.string().parse(row.id)), requestHeaderNames: [] }),
      ),
    );
  },
  async provider(id: string, db = sql, lock = false) {
    return presentProvider(requireRow((await rows("providers", id, db, lock))[0]), db);
  },
  async providerDetail(id: string, db = sql) {
    const provider = await this.provider(id, db);
    return { ...provider, models: (await this.models(db)).filter((model) => model.providerId === id) };
  },
  async modelDetail(id: string, db = sql) {
    const model = await this.model(id, db);
    return {
      ...model,
      variants: (await this.variants(db)).filter((variant) => variant.modelId === id),
      access: (await aiModelAccess.listForAdmin(db))[id],
    };
  },
  async models(db = sql): Promise<AiModel[]> {
    return (await rows("models", undefined, db)).map((row) => AiModelSchema.parse(row));
  },
  async model(id: string, db = sql, lock = false): Promise<AiModel> {
    return AiModelSchema.parse(requireRow((await rows("models", id, db, lock))[0]));
  },
  async variants(db = sql): Promise<AiModelVariant[]> {
    return (await rows("model_variants", undefined, db))
      .map((row) => AiVariantSchema.parse(row))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  },
  async variant(id: string, db = sql, lock = false): Promise<AiModelVariant> {
    return AiVariantSchema.parse(requireRow((await rows("model_variants", id, db, lock))[0]));
  },
  async assignments(db = sql) {
    return (await rows("model_assignments", undefined, db)).map((row) => AiAssignmentSchema.parse(row));
  },
  async assignmentsForAdmin(db = sql) {
    const assignments = await this.assignments(db);
    const usage = await db<
      { class: string; app: string | null; task: string; calls: number }[]
    >`SELECT requested_class AS class,app_id AS app,task,count(*)::int AS calls FROM ai.inference_calls WHERE requested_class IS NOT NULL AND started_at>=now()-interval '14 days' GROUP BY requested_class,app_id,task`;
    return assignments.map((assignment) => {
      const modelClass = AI_MODEL_CLASSES.find((value) => value === assignment.slot);
      const fallbackChain = modelClass ? aiModelClassFallbackChain(modelClass) : [];
      const effectiveClass = modelClass
        ? ([modelClass, ...fallbackChain].find((value) => assignments.some((row) => row.slot === value && row.variantId)) ?? null)
        : null;
      return { ...assignment, fallbackChain, effectiveClass, usage: usage.filter((row) => row.class === assignment.slot) };
    });
  },
  async createProvider(input: z.input<typeof AiProviderInputSchema>, actorId: string) {
    const data = AiProviderInputSchema.parse(input);
    validateProvider(data);
    if (data.logo) data.logo = stripImageDataUrlMetadata(data.logo);
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      await write("providers", data, actorId, db);
      return this.provider(data.id, db);
    });
  },
  async updateProvider(id: string, patch: z.infer<ReturnType<typeof AiProviderInputSchema.partial>>, revision: number, actorId: string) {
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      const current = await this.providerDetail(id, db);
      await assertAiRevision(current, revision, db);
      const data = AiProviderInputSchema.parse({ ...AiProviderInputSchema.strip().parse(current), ...patch, id });
      validateProvider(data);
      if (data.logo) data.logo = stripImageDataUrlMetadata(data.logo);
      for (const model of (await this.models(db)).filter((model) => model.providerId === id)) validateModel(model, { ...current, ...data });
      if (data.type !== current.type || data.baseUrl !== current.baseUrl) {
        await db`DELETE FROM ai.provider_credentials WHERE provider_id=${id}`;
        await db`DELETE FROM ai.provider_request_headers WHERE provider_id=${id}`;
      }
      await write(
        "providers",
        {
          ...data,
          ...(data.type !== current.type || data.baseUrl !== current.baseUrl
            ? { status: "unknown", statusCode: null, statusMessage: null, statusCheckedAt: null }
            : {}),
        },
        actorId,
        db,
        id,
      );
      return this.provider(id, db);
    });
  },
  async createModels(providerId: string, inputs: z.input<typeof AiModelInputSchema>[], actorId: string) {
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      const provider = await this.provider(providerId, db, true);
      const result: AiModel[] = [];
      for (const input of inputs) {
        const data = sanitizeModel(AiModelInputSchema.parse(input));
        validateModel(data, provider);
        if (data.kind === "transcription") data.capabilities = ["transcription"];
        await write("models", { ...data, providerId }, actorId, db);
        await write(
          "model_variants",
          { ...AiVariantInputSchema.parse({ slug: "standard", label: "Standard" }), id: data.id, modelId: data.id },
          actorId,
          db,
        );
        result.push(await this.model(data.id, db));
      }
      await aiModelAccess.syncModels(
        (await this.models(db)).map((model) => model.id),
        [],
        db,
      );
      return result;
    });
  },
  async updateModel(
    id: string,
    patch: Partial<z.infer<typeof AiModelInputSchema>>,
    revision: number,
    actorId: string,
    access?: AiModelAccessDraft,
  ) {
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      const current = await this.modelDetail(id, db);
      await assertAiRevision(current, revision, db);
      const data = sanitizeModel(AiModelInputSchema.parse({ ...AiModelInputSchema.strip().parse(current), ...patch, id }));
      validateModel(data, await this.provider(current.providerId, db));
      if (data.kind === "transcription") data.capabilities = ["transcription"];
      if (data.kind === "transcription" && (await this.variants(db)).some((v) => v.modelId === id && v.slug !== "standard"))
        throw new AiConfigError("invalid_configuration", "Transcription models only have a standard variant.");
      const variantIds = (await this.variants(db)).filter((variant) => variant.modelId === id).map((variant) => variant.id);
      for (const assignment of await this.assignments(db))
        if (assignment.variantId && variantIds.includes(assignment.variantId)) validateAiSlot(assignment.slot, data);
      if (access) {
        try {
          await aiModelAccess.syncModels(
            (await this.models(db)).map((model) => model.id),
            [{ ...access, modelId: id }],
            db,
          );
        } catch (error) {
          if (error instanceof AiModelAccessConflict) {
            const detail = await this.modelDetail(id, db);
            throw new ConfigConflict(detail, null, detail.updatedAt);
          }
          throw error;
        }
      }
      await write("models", data, actorId, db, id);
      return this.model(id, db);
    });
  },
  async createVariant(modelId: string, input: z.input<typeof AiVariantInputSchema>, actorId: string) {
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      const model = await this.model(modelId, db, true);
      if (model.kind !== "chat") throw new AiConfigError("invalid_configuration", "Transcription models only have a standard variant.");
      const data = AiVariantInputSchema.parse(input);
      if (data.slug === "standard") throw new AiConfigError("invalid_configuration", "The standard variant already exists.");
      const id = `${modelId}:${data.slug}`;
      await write("model_variants", { ...data, id, modelId }, actorId, db);
      return this.variant(id, db);
    });
  },
  async updateVariant(id: string, patch: Partial<z.infer<typeof AiVariantInputSchema>>, revision: number, actorId: string) {
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      const current = await this.variant(id, db, true);
      await assertAiRevision(current, revision, db);
      const data = AiVariantInputSchema.parse({ ...AiVariantInputSchema.strip().parse(current), ...patch, slug: current.slug });
      const model = await this.model(current.modelId, db);
      if (model.kind === "transcription" && (data.reasoningEffort || data.extraBody || data.pricing || data.maxOutputTokens))
        throw new AiConfigError("invalid_configuration", "Audio variants do not support chat overrides.");
      await write("model_variants", data, actorId, db, id);
      return this.variant(id, db);
    });
  },
  async assign(slot: import("../shared/ai-models").AiModelSlot, variantId: string | null, revision: number, actorId: string) {
    return sql.begin(async (db) => {
      await lockAiModelCatalog(db);
      const current = AiAssignmentSchema.parse(requireRow((await rows("model_assignments", slot, db, true))[0]));
      await assertAiRevision((await this.assignmentsForAdmin(db)).find((assignment) => assignment.slot === slot) ?? current, revision, db);
      if (variantId) {
        const variant = await this.variant(variantId, db);
        const model = await this.model(variant.modelId, db);
        validateAiSlot(slot, model);
      }
      await write("model_assignments", { variantId }, actorId, db, slot);
      return requireRow((await this.assignments(db)).find((row) => row.slot === slot));
    });
  },
};
export const validateAiSlot = (slot: import("../shared/ai-models").AiModelSlot, model: Pick<AiModel, "kind" | "capabilities">) => {
  if (
    slot === "audio"
      ? model.kind !== "transcription"
      : model.kind !== "chat" || (slot === "vision" && !model.capabilities.includes("vision"))
  )
    throw new AiConfigError("invalid_configuration", "The model does not support this assignment.");
};
export const flattenAiModelVariant = (provider: AiProvider, model: AiModel, variant: AiModelVariant): AiModelProfile => ({
  id: variant.id,
  modelId: model.id,
  providerId: provider.id,
  label: model.label,
  variantLabel: variant.label,
  description: variant.hint || model.description,
  icon: model.icon,
  showInPicker: variant.showInPicker,
  provider: provider.type,
  model: model.providerModel,
  enabled: provider.enabled && model.enabled,
  capabilities: model.capabilities,
  dataBoundary: provider.dataBoundary,
  baseURL: provider.baseUrl ?? undefined,
  contextWindow: model.contextWindow ?? undefined,
  temperature: model.temperature ?? undefined,
  maxOutputTokens: variant.maxOutputTokens ?? model.maxOutputTokens ?? undefined,
  reasoningEffort: variant.reasoningEffort ?? undefined,
  extraBody: { ...model.extraBody, ...variant.extraBody },
  maxLoadedTools: model.maxLoadedTools ?? undefined,
  maxToolRounds: model.maxToolRounds ?? undefined,
  pricing: variant.pricing ?? model.pricing ?? undefined,
});
export const readAiModelProfiles = async (): Promise<AiModelProfile[]> => {
  const [providers, models, variants] = await Promise.all([
    aiModelCatalog.providers(sql, false),
    aiModelCatalog.models(),
    aiModelCatalog.variants(),
  ]);
  return variants.flatMap((variant) => {
    const model = models.find((model) => model.id === variant.modelId);
    const provider = providers.find((provider) => provider.id === model?.providerId);
    return model && provider ? [flattenAiModelVariant(provider, model, variant)] : [];
  });
};
