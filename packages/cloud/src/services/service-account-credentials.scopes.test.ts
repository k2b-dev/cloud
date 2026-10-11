import { expect, test } from "bun:test";
import { AI_INFERENCE_SCOPE, CreateUserApiKeySchema, isModelsOnlyApiKey } from "../contracts/shared";
import { createApiToken, createResourceApiToken, createStandaloneApiToken } from "./service-account-credentials";
import { buildProjectedUser } from "./session/user";

test("personal key access is additive and models-only detection includes mixed scopes", () => {
  expect(CreateUserApiKeySchema.parse({ name: "old client" })).not.toHaveProperty("access");
  expect(CreateUserApiKeySchema.parse({ name: "models", access: "models" }).access).toBe("models");
  expect(CreateUserApiKeySchema.safeParse({ name: "invalid", access: "other" }).success).toBe(false);
  expect(isModelsOnlyApiKey({ scopes: [] })).toBe(false);
  expect(isModelsOnlyApiKey({ scopes: ["read", AI_INFERENCE_SCOPE] })).toBe(true);
});
test("every non-personal creation path refuses the inference scope before database work", async () => {
  const actor = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", uid: "actor", provider: "local", profile: "user" });
  for (const create of [createApiToken, createResourceApiToken, createStandaloneApiToken]) {
    const result = await create({
      serviceAccountId: "22222222-2222-4222-8222-222222222222",
      actor,
      name: "forbidden",
      scopes: ["read", AI_INFERENCE_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
  }
});
