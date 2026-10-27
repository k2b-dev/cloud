import { expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import {
  AiModelInputSchema,
  AiModelPatchSchema,
  AiProviderPatchSchema,
  AiProviderSchema,
  AiVariantPatchSchema,
  AiVariantSchema,
} from "../shared/ai-models";
import * as credentials from "./credentials";
import { aiModelCatalog, flattenAiModelVariant, readAiModelProfiles, validateAiSlot } from "./model-catalog";
import { validateAiReplacement } from "./model-delete";
import * as headers from "./request-headers";

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
  }),
  providerId: provider.id,
  ...metadata,
};
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
