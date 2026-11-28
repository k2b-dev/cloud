import { coreClient } from "@k2b/cloud/clients/core";
import type { AdminMailApp, AdminMailProfile } from "@k2b/cloud/contracts";
import type { outgoingMailMessages } from "./messages";

// What the sections of Outgoing mail share: the API, its error words, and how access is worded.

export type SendersState = {
  profiles: AdminMailProfile[];
  apps: { defaultProfile: string | null; items: AdminMailApp[] };
};
export type Messages = ReturnType<typeof outgoingMailMessages.resolve>["t"];
export type AccessMode = "default" | "selected" | "none";

export const api = coreClient.admin.core["outgoing-mail"];
/** Core's system email (sign-in, password reset, notifications) always uses the default profile. */
export const CORE_APP_ID = "core";
export const MB = 1024 * 1024;

/**
 * Reads the server's `{ code, message }` error body. Known codes get the reader's language; the
 * server's own text stays only for codes without a translation, such as the SMTP answer of `smtp_failed`.
 */
export const failure = async (response: { json: () => Promise<unknown> }, fallback: string, t: Messages) => {
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return new Error(fallback);
  const code = "code" in body && typeof body.code === "string" ? body.code : undefined;
  const message = "message" in body && typeof body.message === "string" ? body.message : undefined;
  const known: Record<string, string> = {
    revision_conflict: t.conflict,
    profile_exists: t.profileExists,
    profile_unknown: t.profileUnknown,
    profile_is_default: t.profileIsDefault,
    invalid_profile: t.invalidEntries,
  };
  return new Error((code ? known[code] : undefined) ?? message ?? fallback);
};

export const loadState = async (signal: AbortSignal, t: Messages): Promise<SendersState> => {
  const [profiles, apps] = await Promise.all([api.profiles.$get({}, { init: { signal } }), api.apps.$get({}, { init: { signal } })]);
  if (!profiles.ok) throw await failure(profiles, t.loadFailed, t);
  if (!apps.ok) throw await failure(apps, t.loadFailed, t);
  return { profiles: (await profiles.json()).items, apps: await apps.json() };
};

export const accessLabel = (app: AdminMailApp, profiles: readonly AdminMailProfile[], t: Messages): string => {
  if (app.mode === "default") {
    const current = profiles.find((profile) => profile.isDefault);
    return current ? t.accessDefaultNamed({ name: current.name }) : t.accessDefault;
  }
  if (!app.profiles.length) return t.accessNone;
  return app.profiles.map((key) => profiles.find((profile) => profile.key === key)?.name ?? key).join(", ");
};

/** Names the other apps whose send log this app may read; its own mail is always readable. */
export const logLabel = (app: AdminMailApp, apps: readonly AdminMailApp[], t: Messages): string =>
  app.logApps.length
    ? t.logAlso({
        names: app.logApps
          .map(
            (id) =>
              `${apps.find((entry) => entry.appId === id)?.name ?? id} (${app.logContentApps?.includes(id) ? t.logContent : t.logMetadata})`,
          )
          .join(", "),
      })
    : t.logOwnOnly;

export type BounceError = NonNullable<NonNullable<AdminMailProfile["bounces"]>["error"]>;
export const bounceReason = (error: BounceError, t: Messages): string =>
  ({
    open_failed: t.bounceOpenFailed,
    target_blocked: t.bounceTargetBlocked,
    search_failed: t.bounceSearchFailed,
    apply_failed: t.bounceApplyFailed,
    save_failed: t.bounceSaveFailed,
    interrupted: t.bounceInterrupted,
  })[error];
