import { password } from "@k2b/stdlib";
import { sql } from "bun";
import type { MutationResult, UserProfile } from "../../contracts/shared";
import { freeipa } from "../../server/services";
import { writeDeletedAccountAudit } from "../account-lifecycle/audit";
import { resolveProviderProfile } from "../accounts/base-user";
import { logger } from "../logging";
import { session } from "../session";
import * as settings from "../settings";
import { ensureFreeIpaMutationAvailable, getIpaUrl } from "./guard";
import { mirrorIpaPosix } from "./posix";

type CreateUser = {
  email: string;
  givenname: string;
  sn: string;
  displayName?: string;
  autoSendNotification?: boolean;
  requestId?: string;
};

type IpaPatchData = {
  givenname?: string;
  sn?: string;
  displayName?: string;
  mail?: string;
  ipa?: {
    phone?: string;
    address?: {
      street?: string;
      postalCode?: string;
      city?: string;
      state?: string;
    };
    sshPublicKeys?: string[];
  };
};

type DbRow = Record<string, unknown>;

const log = logger("auth:ipa");

/**
 * Full-row replacement upsert. Every column is written on UPDATE; omitted
 * fields become NULL (or empty arrays). Use this only for the initial IPA-data
 * insert after user creation or after a full user_show payload. For partial
 * profile patches call `patchUserIpaData` — otherwise SSH keys, uid_number,
 * password expiry, etc. get wiped.
 */
const upsertUserIpaData = async (params: {
  userId: string;
  uidNumber?: number | null;
  primaryGidNumber?: number | null;
  homeDirectory?: string | null;
  loginShell?: string | null;
  phone?: string | null;
  employeeType?: string | null;
  mobile?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  passwordExpires?: Date | null;
  lastLoginIpa?: Date | null;
  syncedAt?: Date | null;
  sshPublicKeys?: string[];
  sshFingerprints?: string[];
}) => {
  await sql.begin(async (tx) => {
    await mirrorIpaPosix(tx, {
      userId: params.userId,
      uidNumber: params.uidNumber ?? null,
      primaryGidNumber: params.primaryGidNumber ?? null,
      homeDirectory: params.homeDirectory ?? null,
      loginShell: params.loginShell ?? null,
    });
    await tx`
    INSERT INTO auth.user_ipa_data (
      user_id, uid_number, phone, employee_type, mobile, addr_street, addr_postal_code,
      addr_city, addr_state, ipa_password_expires, last_login_ipa, synced_at, ssh_public_keys, ssh_fingerprints
    )
    VALUES (
      ${params.userId},
      ${params.uidNumber ?? null},
      ${params.phone ?? null},
      ${params.employeeType ?? null},
      ${params.mobile ?? null},
      ${params.street ?? null},
      ${params.postalCode ?? null},
      ${params.city ?? null},
      ${params.state ?? null},
      ${params.passwordExpires ?? null},
      ${params.lastLoginIpa ?? null},
      ${params.syncedAt ?? null},
      ${freeipa.util.toPgTextArray(params.sshPublicKeys ?? [])}::text[],
      ${freeipa.util.toPgTextArray(params.sshFingerprints ?? [])}::text[]
    )
    ON CONFLICT (user_id) DO UPDATE SET
      uid_number = EXCLUDED.uid_number,
      phone = EXCLUDED.phone,
      employee_type = EXCLUDED.employee_type,
      mobile = EXCLUDED.mobile,
      addr_street = EXCLUDED.addr_street,
      addr_postal_code = EXCLUDED.addr_postal_code,
      addr_city = EXCLUDED.addr_city,
      addr_state = EXCLUDED.addr_state,
      ipa_password_expires = EXCLUDED.ipa_password_expires,
      last_login_ipa = EXCLUDED.last_login_ipa,
      synced_at = EXCLUDED.synced_at,
      ssh_public_keys = EXCLUDED.ssh_public_keys,
      ssh_fingerprints = EXCLUDED.ssh_fingerprints
  `;
  });
};

/**
 * Partial patch for an existing IPA-data row. Only columns whose value is not
 * `undefined` are updated — `null` is still treated as an explicit clear.
 * If no row exists yet the UPDATE is a no-op; callers that need to guarantee a
 * row must use `upsertUserIpaData` first.
 */
const patchUserIpaData = async (params: {
  userId: string;
  phone?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  sshPublicKeys?: string[];
  sshFingerprints?: string[];
  syncedAt?: Date | null;
}) => {
  const has = (v: unknown) => v !== undefined;
  await sql`
    UPDATE auth.user_ipa_data SET
      phone = CASE WHEN ${has(params.phone)} THEN ${params.phone ?? null} ELSE phone END,
      addr_street = CASE WHEN ${has(params.street)} THEN ${params.street ?? null} ELSE addr_street END,
      addr_postal_code = CASE WHEN ${has(params.postalCode)} THEN ${params.postalCode ?? null} ELSE addr_postal_code END,
      addr_city = CASE WHEN ${has(params.city)} THEN ${params.city ?? null} ELSE addr_city END,
      addr_state = CASE WHEN ${has(params.state)} THEN ${params.state ?? null} ELSE addr_state END,
      ssh_public_keys = CASE WHEN ${has(params.sshPublicKeys)}
        THEN ${freeipa.util.toPgTextArray(params.sshPublicKeys ?? [])}::text[]
        ELSE ssh_public_keys END,
      ssh_fingerprints = CASE WHEN ${has(params.sshFingerprints)}
        THEN ${freeipa.util.toPgTextArray(params.sshFingerprints ?? [])}::text[]
        ELSE ssh_fingerprints END,
      synced_at = CASE WHEN ${has(params.syncedAt)} THEN ${params.syncedAt ?? null} ELSE synced_at END
    WHERE user_id = ${params.userId}
  `;
};

// ==========================
// MUTATION: addIpa (create FreeIPA user)
// ==========================

/** Generate random lowercase abbreviation of specified length */
export const generateAbbreviation = (length: number): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const limit = Math.floor(256 / chars.length) * chars.length;
  let value = "";
  while (value.length < length) {
    const bytes = new Uint8Array(length - value.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      value += chars[byte % chars.length]!;
      if (value.length === length) break;
    }
  }
  return value;
};

/** Check if a UID exists in auth.users */
const uidExists = async (uid: string): Promise<boolean> => {
  const rows: DbRow[] = await sql`
    SELECT 1 FROM auth.users
    WHERE uid = ${uid}
    LIMIT 1
  `;
  return rows.length > 0;
};

/** Generate a unique abbreviation that doesn't exist in the database */
export const generateUniqueAbbreviation = async (length: number, maxAttempts = 100): Promise<string> => {
  for (let i = 0; i < maxAttempts; i++) {
    const abbr = generateAbbreviation(length);
    if (!(await uidExists(abbr))) {
      return abbr;
    }
  }
  throw new Error(`Failed to generate unique abbreviation after ${maxAttempts} attempts`);
};

/**
 * Generate a secure random password that meets FreeIPA policy requirements.
 * Delegates to @k2b/stdlib `password.random` which uses rejection
 * sampling over `crypto.getRandomValues`. A length of 20 with all 4 classes
 * makes the probability of any one class being entirely absent astronomically
 * small (~4 × (3/4)^20 ≈ 0.4%) — acceptable for a temporary admin-generated
 * password; operators can retry if FreeIPA rejects on policy.
 */
const generateFreeIpaPassword = (): string => password.random({ length: 20, uppercase: true, numbers: true, symbols: true });

/** Calculate account expiration date based on config */
const calculateAccountExpiration = async (): Promise<Date | null> => {
  const expiresDays = await settings.get<number | null>("user.account.ipa_expires_days");
  const days = expiresDays;

  if (days && days > 0) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    return expiry;
  }

  return null;
};

export type AddIpaResult = {
  id: string;
  uid: string;
  accountExpires: string | null;
  /** The temporary password - only for internal use (email sending), not exposed to client */
  _temporaryPassword: string;
};

/**
 * Create a new user in FreeIPA and the local database.
 * UID = existing guest UID (if promoting) or new abbreviation.
 */
export const addIpa = async (params: {
  ipaSession: string;
  data: CreateUser;
  profile?: UserProfile;
  accountExpires?: Date | null;
}): Promise<MutationResult<AddIpaResult>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const { ipaSession, data } = params;
  const { email, givenname, sn } = data;
  const targetProfile = params.profile ?? "user";

  const displayName = data.displayName || `${givenname} ${sn}`;

  // Check if a local account with this email already exists (provider switch case)
  const existingLocalRows: DbRow[] = await sql`
    SELECT id, uid FROM auth.users WHERE mail = ${email} AND provider = 'local'
  `;

  // Use existing guest UID or generate a new one
  let uid: string;
  if (existingLocalRows.length > 0) {
    uid = existingLocalRows[0]!.uid as string;
  } else {
    try {
      const abbrLen = await settings.get<number>("user.abbr_length");
      uid = await generateUniqueAbbreviation(abbrLen);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Failed to generate UID",
        status: 500,
      };
    }
  }

  if ((await uidExists(uid)) && existingLocalRows.length === 0) {
    return { ok: false, error: `UID '${uid}' already exists`, status: 400 };
  }

  const temporaryPassword = generateFreeIpaPassword();
  const accountExpiry = params.accountExpires === undefined ? await calculateAccountExpiration() : params.accountExpires;
  const now = new Date();

  const ipaOpts: Record<string, unknown> = {
    givenname,
    sn,
    cn: displayName,
    displayname: displayName,
    mail: email,
    userpassword: temporaryPassword,
  };
  if (accountExpiry) {
    ipaOpts.krbprincipalexpiration = freeipa.util.toGeneralizedTime(accountExpiry);
  }

  const response = await freeipa.client.call({ url: await getIpaUrl(), ipaSession, method: "user_add", args: [uid], options: ipaOpts });
  if (response.error) {
    const code = response.error.code;
    if (code === 4001)
      return {
        ok: false,
        error: "IPA session expired. Please log in again.",
        status: 401,
      };
    if (code === 4301)
      return {
        ok: false,
        error: "You don't have permission to create users.",
        status: 403,
      };
    return {
      ok: false,
      error: response.error.message || "Failed to create user.",
      status: 400,
    };
  }

  // Extract uidNumber from IPA response
  const ipaResult = response.result?.result as Record<string, unknown> | undefined;
  const uidNumber = ipaResult ? freeipa.util.num(ipaResult.uidnumber) : null;

  let id: string;
  try {
    if (existingLocalRows.length > 0) {
      // Provider switch: update existing local account to IPA user
      const guestId = existingLocalRows[0]!.id as string;
      const updateRows: DbRow[] = await sql`
        UPDATE auth.users SET
          provider = 'ipa',
          profile = ${targetProfile},
          admin = false,
          given_name = ${givenname},
          sn = ${sn},
          display_name = ${displayName},
          mail = ${email},
          account_expires = ${accountExpiry}
        WHERE id = ${guestId}
        RETURNING id
      `;
      id = updateRows[0]!.id as string;
      await upsertUserIpaData({
        userId: id,
        uidNumber,
        primaryGidNumber: ipaResult ? freeipa.util.num(ipaResult.gidnumber) : null,
        homeDirectory: ipaResult ? freeipa.util.str(ipaResult.homedirectory) || null : null,
        loginShell: ipaResult ? freeipa.util.str(ipaResult.loginshell) || null : null,
        passwordExpires: now,
        syncedAt: now,
      });
      await session.revokeAllForUser(guestId);
    } else {
      // New user: insert
      const insertRows: DbRow[] = await sql`
        INSERT INTO auth.users (uid, provider, profile, admin, given_name, sn, display_name, mail, account_expires)
        VALUES (${uid}, 'ipa', ${targetProfile}, false, ${givenname}, ${sn}, ${displayName}, ${email}, ${accountExpiry})
        ON CONFLICT (uid) DO UPDATE SET
          provider = EXCLUDED.provider,
          profile = EXCLUDED.profile,
          admin = false,
          given_name = EXCLUDED.given_name,
          sn = EXCLUDED.sn,
          display_name = EXCLUDED.display_name,
          mail = EXCLUDED.mail,
          account_expires = EXCLUDED.account_expires
        RETURNING id
      `;
      id = insertRows[0]!.id as string;
      await upsertUserIpaData({
        userId: id,
        uidNumber,
        primaryGidNumber: ipaResult ? freeipa.util.num(ipaResult.gidnumber) : null,
        homeDirectory: ipaResult ? freeipa.util.str(ipaResult.homedirectory) || null : null,
        loginShell: ipaResult ? freeipa.util.str(ipaResult.loginshell) || null : null,
        passwordExpires: now,
        syncedAt: now,
      });
    }
  } catch (dbError) {
    log.error("CRITICAL: FreeIPA user created but local DB update failed. Manual reconciliation needed.", {
      uid,
      email,
      userId: existingLocalRows.length > 0 ? (existingLocalRows[0]!.id as string) : null,
      uidNumber,
      targetProfile,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
    throw dbError;
  }

  return {
    ok: true,
    data: {
      id,
      uid,
      accountExpires: accountExpiry ? accountExpiry.toISOString() : null,
      _temporaryPassword: temporaryPassword,
    },
  };
};

// ==========================
// MUTATION: updateProfile
// ==========================

/**
 * Update user profile. Handles all realms internally.
 */
export const updateProfile = async (params: {
  ipaSession?: string | null;
  id: string;
  data: IpaPatchData;
}): Promise<MutationResult<void>> => {
  const { ipaSession, id, data } = params;

  const userRows: DbRow[] = await sql`SELECT uid, provider, profile FROM auth.users WHERE id = ${id}`;
  if (userRows.length === 0) {
    return { ok: false, error: "User not found", status: 404 };
  }
  const uid = userRows[0]!.uid as string;
  const { provider } = resolveProviderProfile(userRows[0]!);

  if (provider === "ipa") {
    const unavailable = await ensureFreeIpaMutationAvailable();
    if (unavailable) return unavailable;
    if (!ipaSession) {
      return {
        ok: false,
        error: "IPA session required to update IPA user",
        status: 400,
      };
    }

    const ipaOptions: Record<string, unknown> = {};
    if (data.givenname !== undefined) ipaOptions.givenname = data.givenname;
    if (data.sn !== undefined) ipaOptions.sn = data.sn;
    if (data.displayName !== undefined) ipaOptions.displayname = data.displayName;
    if (data.mail !== undefined) ipaOptions.mail = data.mail || "";
    if (data.ipa?.phone !== undefined) ipaOptions.telephonenumber = data.ipa.phone || "";
    if (data.ipa?.address?.street !== undefined) ipaOptions.street = data.ipa.address.street || "";
    if (data.ipa?.address?.postalCode !== undefined) ipaOptions.postalcode = data.ipa.address.postalCode || "";
    if (data.ipa?.address?.city !== undefined) ipaOptions.l = data.ipa.address.city || "";
    if (data.ipa?.address?.state !== undefined) ipaOptions.st = data.ipa.address.state || "";
    if (data.ipa?.sshPublicKeys !== undefined) {
      ipaOptions.ipasshpubkey = data.ipa.sshPublicKeys.length > 0 ? data.ipa.sshPublicKeys : "";
    }

    const response = await freeipa.client.call({
      url: await getIpaUrl(),
      ipaSession,
      method: "user_mod",
      args: [uid],
      options: ipaOptions,
    });
    if (response.error) {
      return {
        ok: false,
        error: response.error.message ?? "Failed to update user in FreeIPA",
        status: freeipa.util.mapIpaErrorCode(response.error.code),
      };
    }

    const result = response.result?.result as Record<string, unknown> | undefined;
    // Partial patch: never touch uid_number, password expiry, last-login, or
    // other full-sync fields when the user is only editing profile attributes.
    await patchUserIpaData({
      userId: id,
      phone: data.ipa?.phone,
      street: data.ipa?.address?.street,
      postalCode: data.ipa?.address?.postalCode,
      city: data.ipa?.address?.city,
      state: data.ipa?.address?.state,
      sshPublicKeys:
        data.ipa?.sshPublicKeys !== undefined ? (Array.isArray(result?.ipasshpubkey) ? (result?.ipasshpubkey as string[]) : []) : undefined,
      sshFingerprints:
        data.ipa?.sshPublicKeys !== undefined ? (Array.isArray(result?.sshpubkeyfp) ? (result?.sshpubkeyfp as string[]) : []) : undefined,
      syncedAt: new Date(),
    });
  }

  await sql`
    UPDATE auth.users
    SET given_name = CASE WHEN ${data.givenname !== undefined} THEN ${data.givenname ?? ""} ELSE given_name END,
        sn = CASE WHEN ${data.sn !== undefined} THEN ${data.sn ?? ""} ELSE sn END,
        display_name = CASE WHEN ${data.displayName !== undefined} THEN ${data.displayName ?? ""} ELSE display_name END
    WHERE id = ${id}
  `;

  if (data.mail !== undefined) {
    await sql`UPDATE auth.users SET mail = ${data.mail || null} WHERE id = ${id}`;
  }

  return { ok: true, data: undefined };
};

// ==========================
// MUTATION: resetPassword
// ==========================

/**
 * Reset a user's password to a new random password.
 */
export const resetPassword = async (params: {
  ipaSession: string;
  /** User ID (database UUID) */
  id: string;
}): Promise<MutationResult<{ password: string }>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const { ipaSession, id } = params;

  // Look up uid from database
  const userRows: DbRow[] = await sql`SELECT uid FROM auth.users WHERE id = ${id}`;
  if (userRows.length === 0) {
    return { ok: false, error: "User not found", status: 404 };
  }
  const uid = userRows[0]!.uid as string;

  const newPassword = generateFreeIpaPassword();

  const response = await freeipa.client.call({
    url: await getIpaUrl(),
    ipaSession,
    method: "user_mod",
    args: [uid],
    options: { userpassword: newPassword },
  });

  if (response.error) {
    return {
      ok: false,
      error: response.error.message ?? "Failed to reset password",
      status: freeipa.util.mapIpaErrorCode(response.error.code),
    };
  }

  // Update password expiry in local DB (password is now "expired" / temporary)
  await sql`
    INSERT INTO auth.user_ipa_data (user_id, ipa_password_expires, synced_at)
    VALUES (${id}, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      ipa_password_expires = EXCLUDED.ipa_password_expires,
      synced_at = EXCLUDED.synced_at
  `;

  return { ok: true, data: { password: newPassword } };
};

// ==========================
// MUTATION: setExpiry
// ==========================

/**
 * Set or remove account expiration date.
 */
export const setExpiry = async (params: {
  ipaSession: string;
  /** User ID (database UUID) */
  id: string;
  expiryDate: string | null;
}): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const { ipaSession, id, expiryDate } = params;

  // Look up uid from database
  const userRows: DbRow[] = await sql`SELECT uid, provider, profile FROM auth.users WHERE id = ${id}`;
  if (userRows.length === 0) {
    return { ok: false, error: "User not found", status: 404 };
  }
  const uid = userRows[0]!.uid as string;
  const { provider, profile } = resolveProviderProfile(userRows[0]!);

  if (provider === "local" && profile === "guest") {
    const guestExpiry = expiryDate ? new Date(expiryDate) : null;
    if (guestExpiry) guestExpiry.setUTCHours(23, 59, 59, 0);
    await sql`
      UPDATE auth.users
      SET account_expires = ${guestExpiry}
      WHERE id = ${id}
    `;
    return { ok: true, data: undefined };
  }

  let dbExpiry: Date | null = null;
  const response = await (async () => {
    if (expiryDate) {
      const date = new Date(expiryDate);
      date.setUTCHours(23, 59, 59, 0);
      const ipaExpiry = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
      dbExpiry = date;
      return freeipa.client.call({
        url: await getIpaUrl(),
        ipaSession,
        method: "user_mod",
        args: [uid],
        options: { krbprincipalexpiration: ipaExpiry },
      });
    }
    return freeipa.client.call({
      url: await getIpaUrl(),
      ipaSession,
      method: "user_mod",
      args: [uid],
      options: { krbprincipalexpiration: null },
    });
  })();

  if (response.error) {
    return {
      ok: false,
      error: response.error.message ?? "Failed to update account expiry",
      status: freeipa.util.mapIpaErrorCode(response.error.code),
    };
  }

  await sql`
    UPDATE auth.users
    SET account_expires = ${dbExpiry}
    WHERE id = ${id}
  `;
  await sql`
    INSERT INTO auth.user_ipa_data (user_id, synced_at)
    VALUES (${id}, now())
    ON CONFLICT (user_id) DO UPDATE SET synced_at = EXCLUDED.synced_at
  `;

  return { ok: true, data: undefined };
};

// ==========================
// MUTATION: demoteToGuest
// ==========================

/**
 * Demote IPA user to guest (removes from FreeIPA, keeps in local DB as guest).
 */
export const demoteToGuest = async (params: {
  ipaSession: string;
  /** User ID (database UUID) */
  id: string;
  actor: { userId: string; uid: string };
}): Promise<MutationResult<void>> => {
  const unavailable = await ensureFreeIpaMutationAvailable();
  if (unavailable) return unavailable;
  const { ipaSession, id, actor } = params;

  const userRows: DbRow[] = await sql`
    SELECT uid, mail, display_name, provider, profile
    FROM auth.users
    WHERE id = ${id} AND provider = 'ipa'
  `;
  if (userRows.length === 0) {
    return {
      ok: false,
      error: "User not found or not an IPA user",
      status: 404,
    };
  }
  const { provider: previousProvider, profile: previousProfile } = resolveProviderProfile(userRows[0]!);
  const uid = userRows[0]!.uid as string;
  const mail = (userRows[0]!.mail as string) ?? null;
  const displayName = (userRows[0]!.display_name as string) ?? null;
  const guestExpiresDays = await settings.get<number | null>("user.account.local_guest_expires_days");
  const accountExpires = guestExpiresDays && guestExpiresDays > 0 ? new Date(Date.now() + guestExpiresDays * 24 * 60 * 60 * 1000) : null;

  log.warn("About to delete IPA user, this cannot be undone", { uid, userId: id });
  const response = await freeipa.client.call({ url: await getIpaUrl(), ipaSession, method: "user_del", args: [uid], options: {} });
  const ipaDeleteMessage = (response.error?.message ?? "").toLowerCase();
  const ipaDeleteNotFound = ipaDeleteMessage.includes("not found") || ipaDeleteMessage.includes("does not exist");
  if (response.error && !ipaDeleteNotFound) {
    return {
      ok: false,
      error: response.error.message ?? "Failed to delete user from FreeIPA",
      status: freeipa.util.mapIpaErrorCode(response.error.code),
    };
  }

  log.info("FreeIPA user deleted, updating local DB", { uid, userId: id });
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE auth.users
        SET provider = 'local', profile = 'guest', admin = false,
            account_expires = ${accountExpires}
        WHERE id = ${id}
      `;
      await tx`DELETE FROM auth.user_ipa_data WHERE user_id = ${id}`;

      await tx`
        DELETE FROM auth.user_groups_v2
        WHERE user_id = ${id}
          AND group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')
      `;
      await tx`
        DELETE FROM auth.group_manager_users_v2
        WHERE user_id = ${id}
          AND group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')
      `;
      await writeDeletedAccountAudit({
        db: tx,
        userId: id,
        uid,
        mail,
        displayName,
        previousProvider,
        previousProfile,
        reason: "manual_demote",
        meta: {
          actorUserId: actor.userId,
          actorUid: actor.uid,
          guestExpiresAt: accountExpires?.toISOString() ?? null,
          freeIpaUserAlreadyMissing: ipaDeleteNotFound,
        },
      });
    });
  } catch (dbError) {
    log.error("CRITICAL: FreeIPA user was deleted but local DB update failed. Manual reconciliation needed.", {
      uid,
      userId: id,
      mail,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
    throw dbError;
  }
  await session.revokeAllForUser(id);

  return { ok: true, data: undefined };
};

// ==========================
// MUTATION: delete
// ==========================

/**
 * Permanently delete user (from FreeIPA if applicable, and from local DB).
 */
export const deleteUser = async (params: {
  ipaSession?: string | null;
  /** User ID (database UUID) */
  id: string;
  actor: { userId: string; uid: string };
}): Promise<MutationResult<void>> => {
  const { ipaSession, id, actor } = params;

  const userRows: DbRow[] = await sql`
    SELECT uid, provider, profile, mail, display_name
    FROM auth.users
    WHERE id = ${id}
  `;
  if (userRows.length === 0) {
    return { ok: false, error: "User not found", status: 404 };
  }
  const uid = userRows[0]!.uid as string;
  const { provider, profile } = resolveProviderProfile(userRows[0]!);
  const mail = (userRows[0]!.mail as string) ?? null;
  const displayName = (userRows[0]!.display_name as string) ?? null;
  let ipaDeleteNotFound = false;

  if (provider === "ipa") {
    const unavailable = await ensureFreeIpaMutationAvailable();
    if (unavailable) return unavailable;
    if (!ipaSession) {
      return {
        ok: false,
        error: "IPA session required to delete IPA user",
        status: 400,
      };
    }
    log.warn("About to delete IPA user, this cannot be undone", { uid, userId: id });
    const response = await freeipa.client.call({ url: await getIpaUrl(), ipaSession, method: "user_del", args: [uid], options: {} });
    const ipaDeleteMessage = (response.error?.message ?? "").toLowerCase();
    ipaDeleteNotFound = ipaDeleteMessage.includes("not found") || ipaDeleteMessage.includes("does not exist");
    if (response.error && !ipaDeleteNotFound) {
      return {
        ok: false,
        error: response.error.message ?? "Failed to delete user from FreeIPA",
        status: freeipa.util.mapIpaErrorCode(response.error.code),
      };
    }
    log.info("FreeIPA user deleted, updating local DB", { uid, userId: id });
  }

  try {
    await sql.begin(async (tx) => {
      await writeDeletedAccountAudit({
        db: tx,
        userId: id,
        uid,
        mail,
        displayName,
        previousProvider: provider,
        previousProfile: profile,
        reason: "manual_delete",
        meta: {
          actorUserId: actor.userId,
          actorUid: actor.uid,
          deletedFromFreeIpa: provider === "ipa",
          freeIpaUserAlreadyMissing: provider === "ipa" ? ipaDeleteNotFound : false,
        },
      });
      await tx`DELETE FROM auth.users WHERE id = ${id}`;
    });
  } catch (dbError) {
    log.error("CRITICAL: FreeIPA user was deleted but local DB update failed. Manual reconciliation needed.", {
      uid,
      userId: id,
      mail,
      provider,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
    throw dbError;
  }
  await session.revokeAllForUser(id);

  return { ok: true, data: undefined };
};
