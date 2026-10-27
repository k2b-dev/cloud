import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { setAiCredential } from "../ai/credentials";
import { AiModelAccessDraftSchema } from "../ai/model-access";
import { AiConfigError, aiModelCatalog, assertAiRevision, lockAiModelCatalog } from "../ai/model-catalog";
import { deleteAiCatalogEntry } from "../ai/model-delete";
import { readAiAdminOverview } from "../ai/model-overview";
import { aiModelUsage } from "../ai/model-usage";
import {
  AiProviderListError,
  listProviderModels,
  recordAiProviderStatus,
  storedProviderConnection,
  testAiProvider,
} from "../ai/provider-connections";
import { getAiRequestHeaders, setAiRequestHeaders } from "../ai/request-headers";
import { type AuthContext, auth, v } from "../server";
import { ConfigConflict } from "../services/config-conflict";
import { ImageMetadataError } from "../services/image-metadata";
import {
  AI_MODEL_SLOTS,
  AiDeleteModelSchema,
  AiModelInputSchema,
  AiModelPatchSchema,
  AiProviderInputSchema,
  AiProviderPatchSchema,
  AiVariantInputSchema,
  AiVariantPatchSchema,
} from "../shared/ai-models";
import { AiRequestHeadersSchema, patchAiRequestHeaders, providerSupportsRequestHeaders } from "../shared/ai-request-options";

const revision = { revision: z.number().int().positive() };
const providerPatch = AiProviderPatchSchema.extend(revision).strict();
const modelPatch = AiModelPatchSchema.extend({ ...revision, access: AiModelAccessDraftSchema.optional() }).strict();
const variantPatch = AiVariantPatchSchema.extend(revision).strict();
const draftConnection = AiProviderInputSchema.omit({ id: true, label: true, dataBoundary: true, enabled: true, logo: true })
  .extend({ apiKey: z.string().optional(), headers: AiRequestHeadersSchema.optional() })
  .strict();
export const createAdminAiRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .onError((error, c) => {
      if (error instanceof ImageMetadataError) return c.json({ code: error.code, message: error.message }, 422);
      if (error instanceof ConfigConflict)
        return c.json({ code: error.code, current: error.current, changedBy: error.changedBy, changedAt: error.changedAt }, 409);
      if (error instanceof AiConfigError)
        return c.json({ code: error.code, message: error.message }, error.code === "model_not_found" ? 404 : 400);
      if (error instanceof AiProviderListError) return c.json({ code: error.code, message: error.message }, 502);
      if (error instanceof z.ZodError) return c.json({ code: "invalid_configuration", message: z.prettifyError(error) }, 400);
      throw error;
    })
    .get("/overview", async (c) => c.json(await readAiAdminOverview()))
    .get("/providers", async (c) => c.json({ providers: await aiModelCatalog.providers() }))
    .post("/providers", v("json", AiProviderInputSchema), async (c) =>
      c.json(await aiModelCatalog.createProvider(c.req.valid("json"), c.get("user").id), 201),
    )
    .post("/providers/test", v("json", draftConnection), async (c) => {
      const data = c.req.valid("json");
      return c.json(await testAiProvider({ ...data, headers: patchAiRequestHeaders({}, data.headers ?? {}) }, c.req.raw.signal));
    })
    .get("/providers/:id", async (c) => {
      return c.json(await aiModelCatalog.providerDetail(c.req.param("id")!));
    })
    .patch("/providers/:id", v("json", providerPatch), async (c) => {
      const { revision, ...patch } = c.req.valid("json");
      return c.json(await aiModelCatalog.updateProvider(c.req.param("id")!, patch, revision, c.get("user").id));
    })
    .put("/providers/:id/credential", v("json", z.object({ ...revision, apiKey: z.string() }).strict()), async (c) => {
      const id = c.req.param("id")!,
        data = c.req.valid("json");
      const saved = await sql.begin(async (db) => {
        await lockAiModelCatalog(db);
        const current = await aiModelCatalog.providerDetail(id, db);
        await assertAiRevision(current, data.revision, db);
        await setAiCredential(id, data.apiKey, db);
        await db`UPDATE ai.providers SET revision=revision+1,updated_by=${c.get("user").id}::uuid,updated_at=clock_timestamp(),status='unknown',status_code=NULL,status_message=NULL,status_checked_at=NULL WHERE id=${id}`;
        return aiModelCatalog.provider(id, db);
      });
      return c.json(saved);
    })
    .put("/providers/:id/headers", v("json", z.object({ ...revision, headers: AiRequestHeadersSchema }).strict()), async (c) => {
      const id = c.req.param("id")!,
        data = c.req.valid("json");
      return c.json(
        await sql.begin(async (db) => {
          await lockAiModelCatalog(db);
          const current = await aiModelCatalog.providerDetail(id, db);
          await assertAiRevision(current, data.revision, db);
          if (!providerSupportsRequestHeaders(current.type))
            throw new AiConfigError("invalid_configuration", "Extra headers require vLLM or an OpenAI-compatible provider.");
          await setAiRequestHeaders(id, patchAiRequestHeaders(await getAiRequestHeaders(id, db), data.headers), db);
          await db`UPDATE ai.providers SET revision=revision+1,updated_by=${c.get("user").id}::uuid,updated_at=clock_timestamp(),status='unknown',status_code=NULL,status_message=NULL,status_checked_at=NULL WHERE id=${id}`;
          return aiModelCatalog.provider(id, db);
        }),
      );
    })
    .post("/providers/:id/test", async (c) => {
      const provider = await aiModelCatalog.provider(c.req.param("id")!);
      const result = await testAiProvider(await storedProviderConnection(provider), c.req.raw.signal);
      await recordAiProviderStatus(provider.id, result, true);
      return c.json(result);
    })
    .get("/providers/:id/available-models", async (c) =>
      c.json({
        models: await listProviderModels(
          await storedProviderConnection(await aiModelCatalog.provider(c.req.param("id")!)),
          c.req.raw.signal,
        ),
      }),
    )
    .post("/providers/:id/models", v("json", z.union([AiModelInputSchema, z.array(AiModelInputSchema).min(1)])), async (c) => {
      const data = c.req.valid("json");
      return c.json(
        { models: await aiModelCatalog.createModels(c.req.param("id")!, Array.isArray(data) ? data : [data], c.get("user").id) },
        201,
      );
    })
    .get("/models", async (c) => c.json({ models: await aiModelCatalog.models() }))
    .get("/models/:id", async (c) => {
      return c.json(await aiModelCatalog.modelDetail(c.req.param("id")!));
    })
    .patch("/models/:id", v("json", modelPatch), async (c) => {
      const { revision, access, ...patch } = c.req.valid("json");
      const model = await aiModelCatalog.updateModel(c.req.param("id")!, patch, revision, c.get("user").id, access);
      return c.json(model);
    })
    .get("/models/:id/usage", async (c) => {
      const model = await aiModelCatalog.model(c.req.param("id")!);
      return c.json(
        await aiModelUsage(
          (await aiModelCatalog.variants()).filter((v) => v.modelId === model.id).map((v) => v.id),
          [model.id],
        ),
      );
    })
    .post("/models/:id/variants", v("json", AiVariantInputSchema), async (c) =>
      c.json(await aiModelCatalog.createVariant(c.req.param("id")!, c.req.valid("json"), c.get("user").id), 201),
    )
    .patch("/variants/:id", v("json", variantPatch), async (c) => {
      const { revision, ...patch } = c.req.valid("json");
      return c.json(await aiModelCatalog.updateVariant(c.req.param("id")!, patch, revision, c.get("user").id));
    })
    .get("/variants/:id/usage", async (c) => {
      const variant = await aiModelCatalog.variant(c.req.param("id")!);
      return c.json(await aiModelUsage([variant.id], [variant.modelId]));
    })
    .delete("/providers/:id", v("json", AiDeleteModelSchema), async (c) =>
      c.json(await deleteAiCatalogEntry("provider", c.req.param("id")!, c.req.valid("json"), c.get("user").id)),
    )
    .delete("/models/:id", v("json", AiDeleteModelSchema), async (c) =>
      c.json(await deleteAiCatalogEntry("model", c.req.param("id")!, c.req.valid("json"), c.get("user").id)),
    )
    .delete("/variants/:id", v("json", AiDeleteModelSchema), async (c) =>
      c.json(await deleteAiCatalogEntry("variant", c.req.param("id")!, c.req.valid("json"), c.get("user").id)),
    )
    .get("/assignments", async (c) => c.json({ assignments: await aiModelCatalog.assignmentsForAdmin() }))
    .put(
      "/assignments/:slot",
      v("param", z.object({ slot: z.enum(AI_MODEL_SLOTS) })),
      v("json", z.object({ ...revision, variantId: z.string().nullable() }).strict()),
      async (c) =>
        c.json(
          await aiModelCatalog.assign(
            c.req.valid("param").slot,
            c.req.valid("json").variantId,
            c.req.valid("json").revision,
            c.get("user").id,
          ),
        ),
    );
export default createAdminAiRoutes();
export type AdminAiApi = ReturnType<typeof createAdminAiRoutes>;
