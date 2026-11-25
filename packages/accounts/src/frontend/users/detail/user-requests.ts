import { apiClient } from "@/api/client";
import type { User } from "@/contracts";
import type { AccountsMessages } from "../../messages";

type NoticeInput = Parameters<typeof import("../../action-notice").showAccountActionNotice>[0];
/** The follow-up notice of a deed loads with the first deed: it brings v1 dialogs the record does not show otherwise. */
const showAccountActionNotice = async (input: NoticeInput, t: AccountsMessages) =>
  (await import("../../action-notice")).showAccountActionNotice(input, t);

// The deeds of a user's page against the Accounts API. Each resolves when the server took it and otherwise throws an
// Error with the server's message, or the deed's own fallback when the answer has none (a proxy page, a lost answer).

type Answer = { ok: boolean; json: () => Promise<unknown> };

const messageOf = (body: unknown): string | null =>
  body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : null;

/** The answer's body when it was taken, else the Error a deed throws. */
const taken = async (response: Answer, fallback: string): Promise<unknown> => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(messageOf(body) ?? fallback);
  return body;
};

/** The person's details for the follow-up notice of an account deed. */
const noticeOf = (user: User) => ({
  id: user.id,
  uid: user.uid,
  name: user.uid,
  email: user.mail ?? "",
  firstName: user.givenname,
  lastName: user.sn,
  provider: user.provider,
  profile: user.profile,
  category: user.provider === "ipa" ? ("freeipa" as const) : user.profile === "guest" ? ("guest" as const) : ("login" as const),
});

export const revokeSignInDevice = async (userId: string, deviceId: string, t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].devices[":deviceId"].$delete({ param: { id: userId, deviceId } }), t.revokeDeviceFailed);
};

/** An already removed phone answers `revoked: false`; that is taken too, the list shows what remains. */
export const removeAppDevice = async (userId: string, deviceId: string, t: AccountsMessages) => {
  await taken(
    await apiClient.users[":id"]["app-devices"][":deviceId"].$delete({ param: { id: userId, deviceId } }),
    t.removeAppDeviceFailed,
  );
};

export const revokeApiKey = async (credentialId: string, t: AccountsMessages) => {
  await taken(await apiClient["service-accounts"].credentials[":id"].$delete({ param: { id: credentialId } }), t.revokeApiKeyFailed);
};

export const removeMembership = async (groupId: string, userId: string, t: AccountsMessages) => {
  await taken(
    await apiClient.groups[":id"].members.$delete({ param: { id: groupId }, json: { type: "user", id: userId } }),
    t.removeFailed,
  );
  await showAccountActionNotice({ action: "group.member.remove", id: groupId, relatedId: userId }, t);
};

export const addMembership = async (groupId: string, userId: string, t: AccountsMessages) => {
  await taken(await apiClient.groups[":id"].members.$post({ param: { id: groupId }, json: { type: "user", id: userId } }), t.addUserFailed);
  await showAccountActionNotice({ action: "group.member.add", id: groupId, relatedId: userId }, t);
};

export type UserEdit = { givenname: string; sn: string; displayName: string; mail?: string | null; ipa?: { phone?: string } };

export const editUser = async (user: User, edit: UserEdit, t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].$patch({ param: { id: user.id }, json: edit }), t.updateUserFailed);
  const email = edit.mail === undefined ? user.mail : edit.mail;
  await showAccountActionNotice(
    { action: "user.update", ...noticeOf(user), email: email ?? "", firstName: edit.givenname, lastName: edit.sn },
    t,
  );
};

/** `null` lets the account never expire. */
export const setExpiry = async (user: User, expiryDate: string | null, t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].expiry.$put({ param: { id: user.id }, json: { expiryDate } }), t.setExpiryFailed);
  await showAccountActionNotice({ action: "user.expiry", ...noticeOf(user) }, t);
};

export const setProfile = async (user: User, profile: "user" | "guest", t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].profile.$put({ param: { id: user.id }, json: { profile } }), t.updateProfileFailed);
  await showAccountActionNotice(
    {
      action: "user.profile",
      ...noticeOf(user),
      profile,
      category: user.provider === "ipa" ? "freeipa" : profile === "guest" ? "guest" : "login",
    },
    t,
  );
};

export const setAdmin = async (user: User, admin: boolean, t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].admin.$put({ param: { id: user.id }, json: { admin } }), t.updateAdminFailed);
  await showAccountActionNotice({ action: "user.admin", ...noticeOf(user) }, t);
};

export const setProvider = async (user: User, provider: "ipa" | "local", t: AccountsMessages) => {
  await taken(
    await apiClient.users[":id"].provider.$put({ param: { id: user.id }, json: { provider } }),
    provider === "ipa" ? t.createIpaFailed : t.makeLocalFailed,
  );
  await showAccountActionNotice(
    {
      action: "user.provider",
      ...noticeOf(user),
      provider,
      category: provider === "ipa" ? "freeipa" : user.profile === "guest" ? "guest" : "login",
    },
    t,
  );
};

const isPassword = (body: unknown): body is { password: string } =>
  !!body && typeof body === "object" && "password" in body && typeof body.password === "string";

/** The temporary password, shown once. */
export const resetPassword = async (user: User, t: AccountsMessages): Promise<string> => {
  const body = await taken(await apiClient.users[":id"]["password-reset"].$post({ param: { id: user.id } }), t.resetPasswordFailed);
  if (!isPassword(body)) throw new Error(t.resetPasswordFailed);
  await showAccountActionNotice({ action: "user.password_reset", ...noticeOf(user) }, t);
  return body.password;
};

export type LoginToken = { token: string; magicLink: string; expiresInSeconds: number };
const isLoginToken = (body: unknown): body is LoginToken =>
  !!body &&
  typeof body === "object" &&
  "token" in body &&
  typeof body.token === "string" &&
  "magicLink" in body &&
  typeof body.magicLink === "string" &&
  "expiresInSeconds" in body &&
  typeof body.expiresInSeconds === "number";

/** A one-time sign-in token and its direct link, shown once. */
export const createLoginToken = async (user: User, t: AccountsMessages): Promise<LoginToken> => {
  const body = await taken(await apiClient.users[":id"]["login-token"].$post({ param: { id: user.id } }), t.createLoginTokenFailed);
  if (!isLoginToken(body)) throw new Error(t.createLoginTokenFailed);
  await showAccountActionNotice({ action: "user.login_token", ...noticeOf(user) }, t);
  return body;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Plain text as paragraphs: every line its own, empty lines dropped, everything escaped. */
export const toSafeParagraphHtml = (value: string): string =>
  value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");

/** The server's sentence about the sent notification. */
export const notifyUser = async (user: User, subject: string, content: string, t: AccountsMessages): Promise<string | null> =>
  messageOf(
    await taken(
      await apiClient.users[":id"].notifications.$post({
        param: { id: user.id },
        json: { subject, rawHtml: toSafeParagraphHtml(content) },
      }),
      t.notifyFailed,
    ),
  );

export const saveAvatar = async (userId: string, dataUrl: string, t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].avatar.$put({ param: { id: userId }, json: { dataUrl } }), t.updateAvatarFailed);
};

export const removeAvatar = async (userId: string, t: AccountsMessages) => {
  await taken(await apiClient.users[":id"].avatar.$delete({ param: { id: userId } }), t.removeAvatarFailed);
};
