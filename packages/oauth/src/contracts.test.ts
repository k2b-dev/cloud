import { describe, expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import {
  CreateOAuthClientSchema,
  DynamicClientRegistrationRequestSchema,
  OAuthClientListQuerySchema,
  OAuthClientParamSchema,
  UpdateOAuthClientSchema,
} from "./contracts";
import oauthRoutes from "./oauth";

describe("OAuth contracts", () => {
  test("OpenAPI documents the login ttl input and optional refresh lifetime output", async () => {
    const spec = await generateSpecs(oauthRoutes);
    const tokenRoute = spec.paths["/oauth/token"]?.post;
    expect(tokenRoute?.requestBody).toMatchObject({
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            oneOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({ ttl: expect.objectContaining({ type: "string", maxLength: 15 }) }),
              }),
              expect.objectContaining({
                properties: expect.objectContaining({
                  grant_type: expect.objectContaining({ const: "refresh_token" }),
                  ttl: expect.objectContaining({ description: "Not accepted for this grant; sending it returns invalid_request." }),
                }),
              }),
            ]),
          },
        },
      },
    });
    expect(spec.paths["/oauth/device_authorization"]?.post?.requestBody).toMatchObject({
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            properties: { ttl: { type: "string", maxLength: 15 } },
          },
        },
      },
    });
    const response = tokenRoute?.responses?.["200"];
    if (!response || "$ref" in response) throw new Error("Token response schema is missing");
    const schema = response.content?.["application/json"]?.schema;
    if (!schema || "$ref" in schema) throw new Error("Token response schema is missing");
    expect(schema.properties?.refresh_token_expires_in).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.required).not.toContain("refresh_token_expires_in");
  });

  test("normalizes create payloads without changing valid client intent", () => {
    const parsed = CreateOAuthClientSchema.parse({
      name: "  Demo client  ",
      description: "  Used by the demo integration.  ",
      redirectUris: [" https://client.example.test/callback ", "https://client.example.test/callback"],
      logoutUri: " https://client.example.test/logout ",
      scopes: ["openid", "profile", "profile", "email"],
      audiences: [" cloud ", "cloud", "api"],
      allowedProfiles: ["user", "user", "guest"],
      accessMode: "specific",
      allowedUserIds: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"],
      allowedGroupIds: ["22222222-2222-4222-8222-222222222222"],
      isPublic: true,
    });

    expect(parsed).toEqual({
      name: "Demo client",
      description: "Used by the demo integration.",
      redirectUris: ["https://client.example.test/callback"],
      logoutUri: "https://client.example.test/logout",
      scopes: ["openid", "profile", "email"],
      audiences: ["cloud", "api"],
      serviceAccountId: undefined,
      allowedProfiles: ["user", "guest"],
      accessMode: "specific",
      allowedUserIds: ["11111111-1111-4111-8111-111111111111"],
      allowedGroupIds: ["22222222-2222-4222-8222-222222222222"],
      isPublic: true,
    });
  });

  test("keeps existing defaults for omitted optional create fields", () => {
    const parsed = CreateOAuthClientSchema.parse({ name: "Demo client" });

    expect(parsed.redirectUris).toEqual([]);
    expect(parsed.scopes).toEqual(["openid", "profile", "email"]);
    expect(parsed.audiences).toEqual(["cloud"]);
    expect(parsed.allowedProfiles).toEqual(["user", "guest"]);
    expect(parsed.accessMode).toBe("profiles");
    expect(parsed.allowedUserIds).toEqual([]);
    expect(parsed.allowedGroupIds).toEqual([]);
    expect(parsed.isPublic).toBe(false);
  });

  test("bounds OAuth client list pagination and search", () => {
    expect(OAuthClientListQuerySchema.parse({ page: "2", per_page: "50", search: "  codex  " })).toEqual({
      page: 2,
      per_page: 50,
      search: "codex",
    });
    expect(OAuthClientListQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(OAuthClientListQuerySchema.safeParse({ per_page: 101 }).success).toBe(false);
    expect(OAuthClientListQuerySchema.safeParse({ search: "x".repeat(201) }).success).toBe(false);
  });

  test("rejects invalid client params and bounded client input", () => {
    expect(OAuthClientParamSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(true);
    expect(OAuthClientParamSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(CreateOAuthClientSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateOAuthClientSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
    expect(CreateOAuthClientSchema.safeParse({ name: "Demo", redirectUris: ["not-a-url"] }).success).toBe(false);
    expect(
      CreateOAuthClientSchema.safeParse({ name: "Demo", redirectUris: Array(51).fill("https://client.example.test/callback") }).success,
    ).toBe(false);
  });

  test("normalizes update payload arrays and nullable fields", () => {
    const parsed = UpdateOAuthClientSchema.parse({
      name: "  Updated client  ",
      description: null,
      logoutUri: null,
      redirectUris: [" https://client.example.test/callback ", "https://client.example.test/callback"],
      scopes: ["read", "read", "write"],
      audiences: [" api ", "api"],
      allowedProfiles: ["guest", "guest"],
      accessMode: "specific",
      allowedUserIds: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"],
      allowedGroupIds: ["22222222-2222-4222-8222-222222222222"],
    });

    expect(parsed).toEqual({
      name: "Updated client",
      description: null,
      logoutUri: null,
      redirectUris: ["https://client.example.test/callback"],
      scopes: ["read", "write"],
      audiences: ["api"],
      allowedProfiles: ["guest"],
      accessMode: "specific",
      allowedUserIds: ["11111111-1111-4111-8111-111111111111"],
      allowedGroupIds: ["22222222-2222-4222-8222-222222222222"],
    });
  });

  test("accepts bounded public dynamic client metadata", () => {
    expect(
      DynamicClientRegistrationRequestSchema.parse({
        client_name: "Codex",
        application_type: "native",
        redirect_uris: ["http://127.0.0.1:49152/callback", "https://client.example.test/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "read write offline_access read",
      }),
    ).toEqual({
      client_name: "Codex",
      application_type: "native",
      redirect_uris: ["http://127.0.0.1:49152/callback", "https://client.example.test/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read write offline_access",
    });
  });

  test("rejects unsafe or privileged dynamic client metadata", () => {
    for (const redirectUri of [
      "http://client.example.test/callback",
      "https://user:password@client.example.test/callback",
      "https://client.example.test/callback#fragment",
    ]) {
      expect(DynamicClientRegistrationRequestSchema.safeParse({ redirect_uris: [redirectUri] }).success).toBe(false);
    }
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({ redirect_uris: ["http://localhost:49152/callback"], scope: "read admin" }).success,
    ).toBe(false);
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({
        redirect_uris: ["http://[::1]:49152/callback"],
        token_endpoint_auth_method: "client_secret_post",
      }).success,
    ).toBe(false);
    expect(
      DynamicClientRegistrationRequestSchema.safeParse({
        client_name: "Trusted\u202eClient",
        redirect_uris: ["http://127.0.0.1:49152/callback"],
      }).success,
    ).toBe(false);
  });
});
