import { type SQL, sql } from "bun";
import { listApps } from "../../_internal/registry";
import {
  type AdminMailApp,
  type AdminMailProfile,
  type MailAppAccess,
  MailAppAccessSchema,
  type MailErrorCode,
  type MailProfile,
  type MailProfileInput,
  MailProfileInputSchema,
  MailProfileKeySchema,
} from "../../contracts/outgoing-mail";
import type { AppRegistryEntry } from "../../contracts/registry";
import { type AuditActor, audit } from "../audit";
import { toPgTextArray } from "../postgres";
import { decryptValue, encryptValue } from "../settings/crypto";

export class OutgoingMailError extends Error {
  constructor(
    public readonly code: MailErrorCode,
    message: string,
    public readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
  }
}
export type MailAuditContext = { actor: AuditActor; requestId?: string };
type ProfileRow = {
  id: string;
  key: string;
  name: string;
  from_address: string;
  from_name: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string | null;
  has_password: boolean;
  pace_per_minute: number;
  daily_recipient_limit: number | null;
  max_attachment_bytes: number;
  is_default: boolean;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  updated_by: string | null;
};
const columns = (db: SQL) => db`id, key, name, from_address, from_name, smtp_host, smtp_port, smtp_secure, smtp_user,
  (smtp_password_encrypted IS NOT NULL) AS has_password, pace_per_minute, daily_recipient_limit, max_attachment_bytes,
  is_default, revision, created_at, updated_at, updated_by`;
const timestamp = (value: Date | string) => new Date(value).toISOString();
const keyValue = (key: string) => {
  const result = MailProfileKeySchema.safeParse(key);
  if (!result.success) throw new OutgoingMailError("invalid_profile", "Invalid profile key.");
  return result.data;
};
const unknown = (): never => {
  throw new OutgoingMailError("profile_unknown", "Outgoing mail profile does not exist.", 404);
};
const locked = async <T>(run: (tx: SQL) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('outgoing_mail.policy', 0))`;
    return run(tx);
  });
const record = (db: SQL, context: MailAuditContext, action: string, target: string) =>
  audit.record(
    {
      ...context,
      action: `outgoing_mail.${action}`,
      outcome: "allowed",
      target: { type: action.startsWith("profile.") ? "outgoing_mail_profile" : "outgoing_mail_app", id: target },
    },
    db,
  );
const accessRows = async (db: SQL) => {
  const access = await db<{ app_id: string; mode: "default" | "selected" }[]>`SELECT app_id, mode FROM outgoing_mail.app_access`;
  const grants = await db<
    { app_id: string; key: string }[]
  >`SELECT ap.app_id, p.key FROM outgoing_mail.app_profiles ap JOIN outgoing_mail.profiles p ON p.id = ap.profile_id ORDER BY p.key`;
  return { access, grants };
};
const mapProfile = (row: ProfileRow, appCount: number): AdminMailProfile => ({
  key: row.key,
  name: row.name,
  fromAddress: row.from_address,
  fromName: row.from_name,
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpSecure: row.smtp_secure,
  smtpUser: row.smtp_user,
  hasPassword: row.has_password,
  pacePerMinute: row.pace_per_minute,
  dailyRecipientLimit: row.daily_recipient_limit,
  maxAttachmentBytes: row.max_attachment_bytes,
  isDefault: row.is_default,
  revision: row.revision,
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
  updatedBy: row.updated_by,
  appCount,
});
const list = async (db: SQL = sql, registeredApps?: readonly AppRegistryEntry[]): Promise<AdminMailProfile[]> => {
  const apps = registeredApps ?? (await listApps());
  const rows = await db<ProfileRow[]>`SELECT ${columns(db)} FROM outgoing_mail.profiles ORDER BY is_default DESC, name, key`;
  const { access, grants } = await accessRows(db);
  const selected = new Set(access.filter((a) => a.mode === "selected").map((a) => a.app_id));
  const defaults = apps.filter((app) => app.platformPermissions?.includes("mail:send") && !selected.has(app.id));
  return rows.map((row) =>
    mapProfile(row, grants.filter((g) => g.key === row.key && selected.has(g.app_id)).length + (row.is_default ? defaults.length : 0)),
  );
};
const get = async (key: string): Promise<AdminMailProfile> => {
  keyValue(key);
  return (await list()).find((profile) => profile.key === key) ?? unknown();
};
const put = async (
  key: string,
  value: MailProfileInput,
  context: MailAuditContext,
): Promise<{ profile: AdminMailProfile; created: boolean }> => {
  keyValue(key);
  const parsed = MailProfileInputSchema.safeParse(value);
  if (!parsed.success) throw new OutgoingMailError("invalid_profile", "Invalid outgoing mail profile configuration.");
  const input = parsed.data;
  const apps = await listApps();
  return locked(async (tx) => {
    const [before] = await tx<ProfileRow[]>`SELECT ${columns(tx)} FROM outgoing_mail.profiles WHERE key = ${key}`;
    if (before && input.revision === undefined)
      throw new OutgoingMailError("profile_exists", "Profile exists; provide its current revision.", 409);
    if (input.revision !== undefined && (!before || input.revision !== before.revision))
      throw new OutgoingMailError("revision_conflict", "Profile revision changed; reload before replacing it.", 409);
    if (
      before?.has_password &&
      input.smtpPassword === undefined &&
      before.smtp_host.trim().toLowerCase() !== input.smtpHost.trim().toLowerCase()
    )
      throw new OutgoingMailError("invalid_profile", "Enter the SMTP password again, or remove it, when you change the SMTP host.");
    const password =
      input.smtpPassword === undefined ? undefined : input.smtpPassword === null ? null : await encryptValue(input.smtpPassword);
    if (before) {
      await tx`UPDATE outgoing_mail.profiles SET name = ${input.name}, from_address = ${input.fromAddress}, from_name = ${input.fromName},
        smtp_host = ${input.smtpHost}, smtp_port = ${input.smtpPort}, smtp_secure = ${input.smtpSecure}, smtp_user = ${input.smtpUser},
        smtp_password_encrypted = CASE WHEN ${password !== undefined} THEN ${password ?? null} ELSE smtp_password_encrypted END,
        pace_per_minute = ${input.pacePerMinute}, daily_recipient_limit = ${input.dailyRecipientLimit}, max_attachment_bytes = ${input.maxAttachmentBytes},
        revision = revision + 1, updated_at = now(), updated_by = ${context.actor.userId ?? null} WHERE key = ${key}`;
    } else {
      await tx`INSERT INTO outgoing_mail.profiles(id, key, name, from_address, from_name, smtp_host, smtp_port, smtp_secure, smtp_user,
        smtp_password_encrypted, pace_per_minute, daily_recipient_limit, max_attachment_bytes, is_default, updated_by)
        VALUES (${crypto.randomUUID()}::uuid, ${key}, ${input.name}, ${input.fromAddress}, ${input.fromName}, ${input.smtpHost}, ${input.smtpPort},
          ${input.smtpSecure}, ${input.smtpUser}, ${password ?? null}, ${input.pacePerMinute}, ${input.dailyRecipientLimit}, ${input.maxAttachmentBytes},
          NOT EXISTS(SELECT 1 FROM outgoing_mail.profiles), ${context.actor.userId ?? null})`;
    }
    await record(tx, context, before ? "profile.update" : "profile.create", key);
    return { profile: (await list(tx, apps)).find((p) => p.key === key)!, created: !before };
  });
};
const setDefault = async (key: string, context: MailAuditContext): Promise<AdminMailProfile> => {
  keyValue(key);
  const apps = await listApps();
  return locked(async (tx) => {
    const [target] = await tx<{ key: string }[]>`SELECT key FROM outgoing_mail.profiles WHERE key = ${key}`;
    if (!target) unknown();
    await tx`UPDATE outgoing_mail.profiles SET is_default = false, revision = revision + 1, updated_at = now(), updated_by = ${context.actor.userId ?? null} WHERE is_default AND key <> ${key}`;
    await tx`UPDATE outgoing_mail.profiles SET is_default = true, revision = revision + 1, updated_at = now(), updated_by = ${context.actor.userId ?? null} WHERE key = ${key} AND NOT is_default`;
    await record(tx, context, "profile.set_default", key);
    return (await list(tx, apps)).find((p) => p.key === key)!;
  });
};
const remove = async (key: string, context: MailAuditContext): Promise<void> => {
  keyValue(key);
  await locked(async (tx) => {
    const [before] = await tx<{ is_default: boolean }[]>`SELECT is_default FROM outgoing_mail.profiles WHERE key = ${key}`;
    if (!before) return unknown();
    if (before.is_default)
      throw new OutgoingMailError("profile_is_default", "Choose another default profile before deleting this one.", 409);
    await tx`DELETE FROM outgoing_mail.profiles WHERE key = ${key}`;
    await record(tx, context, "profile.delete", key);
  });
};
const appsState = async (
  db: SQL = sql,
  registeredApps?: readonly AppRegistryEntry[],
): Promise<{ defaultProfile: string | null; items: AdminMailApp[] }> => {
  const registered = registeredApps ?? (await listApps());
  const { access, grants } = await accessRows(db);
  const [profile] = await db<{ key: string }[]>`SELECT key FROM outgoing_mail.profiles WHERE is_default`;
  const ids = new Set([...registered.map((app) => app.id), ...access.map((a) => a.app_id)]);
  const items = [...ids]
    .map((appId): AdminMailApp => {
      const app = registered.find((a) => a.id === appId);
      const mode = access.find((a) => a.app_id === appId)?.mode ?? "default";
      return {
        appId,
        name: app?.name ?? appId,
        registered: !!app,
        declared: !!app?.platformPermissions?.includes("mail:send"),
        mode,
        profiles: mode === "selected" ? grants.filter((g) => g.app_id === appId).map((g) => g.key) : [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId));
  return { defaultProfile: profile?.key ?? null, items };
};
const setAppAccess = async (appId: string, value: MailAppAccess, context: MailAuditContext): Promise<AdminMailApp> => {
  if (appId === "core") throw new OutgoingMailError("invalid_profile", "Core's system email always uses the default profile.");
  if (!appId.trim()) throw new OutgoingMailError("invalid_profile", "Application id is required.");
  const parsed = MailAppAccessSchema.safeParse(value);
  if (!parsed.success) throw new OutgoingMailError("invalid_profile", "Invalid application access policy.");
  const input = parsed.data;
  const registered = await listApps();
  return locked(async (tx) => {
    const keys = input.mode === "selected" ? [...new Set(input.profiles)] : [];
    const rows = await tx<
      { id: string; key: string }[]
    >`SELECT id, key FROM outgoing_mail.profiles WHERE key = ANY(${toPgTextArray(keys)}::text[])`;
    if (rows.length !== keys.length) throw new OutgoingMailError("profile_unknown", "An outgoing mail profile does not exist.");
    await tx`DELETE FROM outgoing_mail.app_profiles WHERE app_id = ${appId}`;
    if (input.mode === "default") await tx`DELETE FROM outgoing_mail.app_access WHERE app_id = ${appId}`;
    else {
      await tx`INSERT INTO outgoing_mail.app_access(app_id, mode, updated_by) VALUES (${appId}, 'selected', ${context.actor.userId ?? null})
        ON CONFLICT(app_id) DO UPDATE SET mode = 'selected', updated_at = now(), updated_by = EXCLUDED.updated_by`;
      for (const row of rows) await tx`INSERT INTO outgoing_mail.app_profiles(app_id, profile_id) VALUES (${appId}, ${row.id}::uuid)`;
    }
    await record(tx, context, "app_access.update", appId);
    return (
      (await appsState(tx, registered)).items.find((app) => app.appId === appId) ?? {
        appId,
        name: appId,
        registered: false,
        declared: false,
        mode: "default",
        profiles: [],
      }
    );
  });
};
const profilesForApp = async (appId: string): Promise<MailProfile[]> => {
  const rows = await sql<
    {
      key: string;
      name: string;
      from_address: string;
      is_default: boolean;
      max_attachment_bytes: number;
      daily_recipient_limit: number | null;
    }[]
  >`
    SELECT p.key, p.name, p.from_address, p.is_default, p.max_attachment_bytes, p.daily_recipient_limit
    FROM outgoing_mail.profiles p WHERE
      CASE WHEN EXISTS(SELECT 1 FROM outgoing_mail.app_access WHERE app_id = ${appId} AND mode = 'selected')
      THEN EXISTS(SELECT 1 FROM outgoing_mail.app_profiles WHERE app_id = ${appId} AND profile_id = p.id)
      ELSE p.is_default END ORDER BY p.is_default DESC, p.name, p.key`;
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    from: row.from_address,
    default: row.is_default,
    maxAttachmentBytes: row.max_attachment_bytes,
    quota: { dailyRecipients: row.daily_recipient_limit, usedLast24h: 0 },
  }));
};
export const outgoingMailStore = { list, get, put, setDefault, delete: remove, apps: appsState, setAppAccess, profilesForApp };

/** Platform email send path only. Never use this helper to shape API or CLI responses. */
export const resolveMailCredentials = async (key?: string) => {
  const [row] = await sql<(ProfileRow & { smtp_password_encrypted: string | null })[]>`
    SELECT ${columns(sql)}, smtp_password_encrypted FROM outgoing_mail.profiles WHERE ${key === undefined ? sql`is_default` : sql`key = ${keyValue(key)}`}`;
  if (!row)
    throw new OutgoingMailError(
      "profile_unknown",
      key ? "Outgoing mail profile does not exist." : "Configure a default outgoing mail profile before sending email.",
      404,
    );
  const password = row.smtp_password_encrypted === null ? null : await decryptValue(row.smtp_password_encrypted);
  if (password !== null && typeof password !== "string") throw new Error("Outgoing mail SMTP password is invalid.");
  return {
    fromAddress: row.from_address,
    fromName: row.from_name,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure,
    smtpUser: row.smtp_user,
    smtpPassword: password,
  };
};
