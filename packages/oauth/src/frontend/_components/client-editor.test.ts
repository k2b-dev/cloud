import { describe, expect, test } from "bun:test";
import { CreateOAuthClientSchema, type OAuthAllowedProfile, type OAuthClient, UpdateOAuthClientSchema } from "../../contracts";
import { clientEditorUpdate, clientEditorValues, profileChoice, profilesForChoice } from "./client-editor";

const client = (overrides: Partial<OAuthClient> = {}): OAuthClient => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Existing client",
  description: "Original description",
  clientId: "existing-client",
  redirectUris: ["https://first.example/callback", "https://second.example/callback"],
  logoutUri: "https://first.example/logout",
  scopes: ["openid", "email"],
  audiences: ["custom-api"],
  serviceAccountId: null,
  allowedProfiles: ["user"],
  accessMode: "profiles",
  accessUsers: [],
  accessGroups: [],
  registrationKind: "managed",
  isPublic: false,
  allowDeviceGrant: false,
  createdAt: "2026-09-15T00:00:00Z",
  createdBy: null,
  ...overrides,
});

const userId = "22222222-2222-4222-8222-222222222222";
const groupId = "33333333-3333-4333-8333-333333333333";

describe("OAuth client editor updates", () => {
  test("editing description preserves every callback and leaves non-editable authority fields untouched", () => {
    const existing = client();
    const payload = UpdateOAuthClientSchema.parse(clientEditorUpdate({ ...clientEditorValues(existing), description: "Changed" }));
    expect(payload.redirectUris).toEqual(existing.redirectUris);
    expect(payload.scopes).toEqual(existing.scopes);
    expect(payload.logoutUri).toBe(existing.logoutUri);
    expect(payload.description).toBe("Changed");
    expect(payload).not.toHaveProperty("audiences");
    expect(payload).not.toHaveProperty("serviceAccountId");
  });

  test("unrelated edits preserve every profile restriction, including when specific principals are selected", () => {
    const cases: OAuthAllowedProfile[][] = [[], ["guest"], ["user"], ["guest", "user"]];
    for (const allowedProfiles of cases) {
      for (const accessMode of ["profiles", "specific"] as const) {
        const existing = client({
          allowedProfiles,
          accessMode,
          accessUsers:
            accessMode === "specific" ? [{ id: userId, uid: "member", displayName: "Member", mail: null, provider: "local" }] : [],
          accessGroups: accessMode === "specific" ? [{ id: groupId, name: "Group", description: null, provider: "local" }] : [],
        });
        const payload = UpdateOAuthClientSchema.parse(clientEditorUpdate({ ...clientEditorValues(existing), description: "Changed" }));
        expect(payload.allowedProfiles).toEqual(allowedProfiles);
        expect(payload.accessMode).toBe(accessMode);
        expect(payload.allowedUserIds).toEqual(existing.accessUsers.map((user) => user.id));
        expect(payload.allowedGroupIds).toEqual(existing.accessGroups.map((group) => group.id));
        expect(new Set(profilesForChoice(profileChoice(allowedProfiles)))).toEqual(new Set(allowedProfiles));
      }
    }
  });

  test("machine clients keep empty callbacks and no user access when edited", () => {
    const payload = UpdateOAuthClientSchema.parse(
      clientEditorUpdate(clientEditorValues(client({ redirectUris: [], allowedProfiles: [] }))),
    );
    expect(payload.redirectUris).toEqual([]);
    expect(payload.allowedProfiles).toEqual([]);
  });

  test("explicit callback edits support multiple lines, quoted pastes, removal, and reject invalid URLs at the API contract", () => {
    const values = clientEditorValues(client());
    const payload = clientEditorUpdate({
      ...values,
      redirectUris: ' "https://replacement.example/callback" \r\n\nhttps://second.example/callback\n',
    });
    expect(UpdateOAuthClientSchema.parse(payload).redirectUris).toEqual([
      "https://replacement.example/callback",
      "https://second.example/callback",
    ]);
    expect(UpdateOAuthClientSchema.parse(clientEditorUpdate({ ...values, redirectUris: "" })).redirectUris).toEqual([]);
    expect(UpdateOAuthClientSchema.safeParse(clientEditorUpdate({ ...values, redirectUris: "not-a-url" })).success).toBe(false);
  });

  test("new clients keep full-user defaults and allow no browser callback", () => {
    const fields = clientEditorUpdate(clientEditorValues());
    const payload = CreateOAuthClientSchema.parse({
      ...fields,
      description: fields.description ?? undefined,
      logoutUri: fields.logoutUri ?? undefined,
      name: "Machine",
      audiences: ["cloud"],
      isPublic: false,
    });
    expect(payload.allowedProfiles).toEqual(["user"]);
    expect(payload.redirectUris).toEqual([]);
    expect(payload.accessMode).toBe("profiles");
  });
});
