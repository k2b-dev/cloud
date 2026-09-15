import type { OAuthAllowedProfile, OAuthClient, UpdateOAuthClient } from "../../contracts";

export type ProfileChoice = "user" | "everybody" | "guest" | "none";

export const profileChoice = (profiles: OAuthAllowedProfile[]): ProfileChoice =>
  profiles.includes("user") ? (profiles.includes("guest") ? "everybody" : "user") : profiles.includes("guest") ? "guest" : "none";

export const profilesForChoice = (choice: ProfileChoice): OAuthAllowedProfile[] =>
  choice === "everybody" ? ["user", "guest"] : choice === "none" ? [] : [choice];

/** Keep every existing callback and profile when opening the editor. */
export const clientEditorValues = (client?: OAuthClient) => ({
  description: client?.description ?? "",
  redirectUris: client?.redirectUris.join("\n") ?? "",
  logoutUri: client?.logoutUri ?? "",
  scopes: client?.scopes ?? (["openid", "profile", "email"] satisfies OAuthClient["scopes"]),
  allowedProfiles: client?.allowedProfiles ?? (["user"] satisfies OAuthAllowedProfile[]),
  specific: client?.accessMode === "specific",
  allowedUserIds: client?.accessUsers.map((user) => user.id) ?? [],
  allowedGroupIds: client?.accessGroups.map((group) => group.id) ?? [],
});

export type ClientEditorValues = ReturnType<typeof clientEditorValues>;

/** Convert the complete editable fields to the existing update contract. */
export const clientEditorUpdate = (values: ClientEditorValues) =>
  ({
    description: values.description.trim() || null,
    redirectUris: values.redirectUris
      .split(/\r?\n/)
      .map((uri) => uri.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
    logoutUri: values.logoutUri.trim() || null,
    scopes: values.scopes,
    allowedProfiles: values.allowedProfiles,
    accessMode: values.specific ? "specific" : "profiles",
    allowedUserIds: values.specific ? values.allowedUserIds : [],
    allowedGroupIds: values.specific ? values.allowedGroupIds : [],
  }) satisfies UpdateOAuthClient;
