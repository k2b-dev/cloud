import { expect, spyOn, test } from "bun:test";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { sql } from "../runtime/clients";

import {
  AiAssignmentSchema,
  AiModelInputSchema,
  AiModelPatchSchema,
  AiModelSchema,
  AiProviderInputSchema,
  AiProviderPatchSchema,
  AiProviderSchema,
  AiVariantInputSchema,
  AiVariantPatchSchema,
  AiVariantSchema,
} from "../shared/ai-models";
import {
  AiModelSchema as LegacyAiModelSchema,
  AiAssignmentSchema as LegacyAssignmentSchema,
  AiProviderSchema as LegacyProviderSchema,
} from "./catalog-v0.70.test-fixture";
import * as credentials from "./credentials";
import { aiModelCatalog, flattenAiModelVariant, readAiModelProfiles, validateAiSlot } from "./model-catalog";
import { validateAiReplacement } from "./model-delete";
import * as headers from "./request-headers";

useUnitClients();

const metadata = { revision: 1, updatedAt: "2026-10-16T00:00:00.000Z", createdAt: "2026-10-16T00:00:00.000Z", updatedBy: null };
const provider = AiProviderSchema.parse({
  id: "private",
  type: "ollama",
  label: "Private",
  dataBoundary: "private",
  ...metadata,
  status: "unknown",
  statusCode: null,
  statusMessage: null,
  statusCheckedAt: null,
  credentialSet: false,
  requestHeaderNames: [],
});
const model = {
  ...AiModelInputSchema.parse({
    id: "chat",
    providerModel: "upstream",
    label: "Chat",
    capabilities: ["tools", "vision"],
    extraBody: { custom: 1 },
    outputTokenLimit: 65_536,
  }),
  providerId: provider.id,
  ...metadata,
};
test("stored catalog schemas strip future columns while admin inputs stay strict", () => {
  const variant = AiVariantSchema.parse({ slug: "standard", id: "chat", modelId: "chat", label: "Standard", ...metadata });
  const assignment = AiAssignmentSchema.parse({ slot: "balanced", variantId: "chat", ...metadata });
  for (const [schema, row] of [
    [AiProviderSchema, provider],
    [AiModelSchema, model],
    [AiVariantSchema, variant],
    [AiAssignmentSchema, assignment],
  ] as const) {
    expect(schema.parse({ ...row, futureColumn: "added later" })).toEqual(row);
  }
  expect(
    AiProviderInputSchema.safeParse({ id: "private", type: "ollama", label: "Private", dataBoundary: "private", futureColumn: 1 }).success,
  ).toBe(false);
  expect(AiModelInputSchema.safeParse({ id: "chat", providerModel: "upstream", label: "Chat", futureColumn: 1 }).success).toBe(false);
  expect(AiVariantInputSchema.safeParse({ slug: "deep", label: "Deep", futureColumn: 1 }).success).toBe(false);
});
test("the frozen 0.70 reader accepts base model rows and rejects the unreleased column", () => {
  const { outputTokenLimit, ...stored } = model;
  expect(LegacyAiModelSchema.parse(stored)).toEqual(stored);
  expect(LegacyAiModelSchema.safeParse({ ...stored, outputTokenLimit }).success).toBe(false);
});
test("catalog enum values match the frozen 0.70 readers", () => {
  expect(AiProviderSchema.shape.type.options).toEqual(LegacyProviderSchema.shape.type.options);
  expect(AiProviderSchema.shape.dataBoundary.options).toEqual(LegacyProviderSchema.shape.dataBoundary.options);
  expect(AiProviderSchema.shape.status.options).toEqual(LegacyProviderSchema.shape.status.options);
  expect(AiModelSchema.shape.kind.unwrap().options).toEqual(LegacyAiModelSchema.shape.kind.unwrap().options);
  expect(AiModelSchema.shape.capabilities.unwrap().element.options).toEqual(
    LegacyAiModelSchema.shape.capabilities.unwrap().element.options,
  );
  expect(AiModelSchema.shape.icon.unwrap().options.map((option) => option.shape.kind.value)).toEqual(
    LegacyAiModelSchema.shape.icon.unwrap().options.map((option) => option.shape.kind.value),
  );
  expect(AiAssignmentSchema.shape.slot.options).toEqual(LegacyAssignmentSchema.shape.slot.options);
});
test("model readers join limits explicitly, strip future columns, and lock only the model row", async () => {
  const query = spyOn(sql, "unsafe").mockResolvedValue([{ data: { ...model, future_column: "added later" } }]);
  try {
    expect(await aiModelCatalog.models()).toEqual([model]);
    expect(query.mock.calls[0]?.[0]).toContain("LEFT JOIN ai.model_output_limits");
    expect(await aiModelCatalog.model(model.id, sql, true)).toEqual(model);
    expect(query.mock.calls[1]?.[0]).toContain("WHERE t.id=$1 FOR UPDATE OF t");
    expect(query.mock.calls[1]?.[1]).toEqual([model.id]);
  } finally {
    query.mockRestore();
  }
});
test("variants flatten connection, model and overrides into one runtime shape", () => {
  const variant = AiVariantSchema.parse({
    slug: "deep",
    id: "chat:deep",
    modelId: "chat",
    label: "Thorough",
    hint: "Hard questions",
    extraBody: { custom: 2 },
    maxOutputTokens: 300,
    ...metadata,
  });
  expect(flattenAiModelVariant(provider, model, variant)).toMatchObject({
    id: "chat:deep",
    modelId: "chat",
    providerId: "private",
    model: "upstream",
    description: "Hard questions",
    variantLabel: "Thorough",
    extraBody: { custom: 2 },
    maxOutputTokens: 300,
  });
  expect(flattenAiModelVariant(provider, model, variant).outputTokenLimit).toBe(65_536);
});
test("deletion replacements preserve boundary, kind and capabilities", () => {
  expect(() => validateAiReplacement(provider, provider, model, model)).not.toThrow();
  for (const target of [
    { ...provider, dataBoundary: "hosted" as const },
    { ...provider, enabled: false },
  ])
    expect(() => validateAiReplacement(provider, target, model, model)).toThrow();
  expect(() => validateAiReplacement(provider, provider, model, { ...model, capabilities: [] })).toThrow();
  expect(() => validateAiSlot("audio", model)).toThrow();
  expect(() => validateAiSlot("vision", model)).not.toThrow();
});
test("patch schemas keep omitted defaults absent and reject old connection fields", () => {
  expect(AiProviderPatchSchema.parse({ label: "Renamed" })).toEqual({ label: "Renamed" });
  expect(AiModelPatchSchema.parse({ label: "Renamed" })).toEqual({ label: "Renamed" });
  expect(AiModelPatchSchema.parse({ outputTokenLimit: null })).toEqual({ outputTokenLimit: null });
  expect(AiVariantPatchSchema.parse({ label: "Renamed" })).toEqual({ label: "Renamed" });
  expect(AiModelInputSchema.safeParse({ id: "old", provider: "ollama", model: "old", label: "Old" }).success).toBe(false);
});

test("runtime catalog reads use key existence and never decrypt provider headers", async () => {
  const query = spyOn(sql, "unsafe").mockResolvedValue([
    { data: { ...provider, credentialSet: undefined, requestHeaderNames: undefined } },
  ]);
  const keys = spyOn(credentials, "listAiCredentialProviderIds").mockResolvedValue([provider.id]);
  const decryptKey = spyOn(credentials, "getAiCredential").mockRejectedValue(new Error("Must not decrypt keys"));
  const decryptHeaders = spyOn(headers, "getAiRequestHeaders").mockRejectedValue(new Error("Must not decrypt headers"));
  const models = spyOn(aiModelCatalog, "models").mockResolvedValue([model]);
  const variants = spyOn(aiModelCatalog, "variants").mockResolvedValue([
    AiVariantSchema.parse({ slug: "standard", id: "chat", modelId: "chat", label: "Standard", ...metadata }),
  ]);
  try {
    expect((await readAiModelProfiles()).map((profile) => profile.id)).toEqual(["chat"]);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(decryptKey).not.toHaveBeenCalled();
    expect(decryptHeaders).not.toHaveBeenCalled();
  } finally {
    variants.mockRestore();
    models.mockRestore();
    decryptHeaders.mockRestore();
    decryptKey.mockRestore();
    keys.mockRestore();
    query.mockRestore();
  }
});
