import { sql } from "bun";
import type { MutationResult, UserProfile } from "../../../contracts/shared";
import { writeDeletedAccountAudit } from "../../account-lifecycle/audit";
import { resolveStoredAdminState } from "../../accounts/model";
import { writeLocalAccount } from "../../accounts/posix";
import type { AuditActor } from "../../audit";
import { generateUniqueAbbreviation } from "../../ipa/users";
import { isUniqueViolation } from "../../postgres";
import { session } from "../../session";
import * as settings from "../../settings";

type DbRow = Record<string, unknown>;

export type LocalUserCreateData = {
  email: string;
  givenname?: string;
  sn?: string;
  displayName?: string;
};

const createLocalUid = async (): Promise<string> => {
  const abbrLen = await settings.get<number>("user.abbr_length");
  return generateUniqueAbbreviation(abbrLen);
};

export const create = async (params: {
  data: LocalUserCreateData;
  profile: UserProfile;
  accountExpires: Date | null;
  admin?: boolean;
  actor?: AuditActor;
}): Promise<MutationResult<{ id: string }>> => {
  const uid = await createLocalUid();
  const admin = resolveStoredAdminState({
    provider: "local",
    profile: params.profile,
    requestedAdmin: params.admin,
  });

  try {
    return await writeLocalAccount(async (tx) => {
      const rows = await tx<{ id: string }[]>`
      INSERT INTO auth.users (
        uid,
        provider,
        profile,
        mail,
        given_name,
        sn,
        display_name,
        admin,
        account_expires
      )
      VALUES (
        ${uid},
        'local',
        ${params.profile},
        ${params.data.email},
        ${params.data.givenname ?? ""},
        ${params.data.sn ?? ""},
        ${params.data.displayName ?? ""},
        ${admin},
        ${params.accountExpires}
      )
      RETURNING id
    `;
      return { ok: true, data: { id: rows[0]!.id } };
    }, params.actor);
  } catch (error) {
    // Map Postgres unique violations to a typed 409 instead of leaking raw DB
    // errors. Two possible collisions: generated uid (extremely rare, retry at
    // next call) or email already used by another local account.
    if (isUniqueViolation(error, "users_uid_key")) {
      return { ok: false, error: "Generated UID collided. Please retry.", status: 409 };
    }
    if (isUniqueViolation(error, "idx_users_provider_mail")) {
      return { ok: false, error: "A local account with this email already exists.", status: 409 };
    }
    throw error;
  }
};

export const createGuest = async (params: {
  email: string;
  givenname?: string;
  sn?: string;
  displayName?: string;
  accountExpires?: Date | null;
}): Promise<MutationResult<{ id: string }>> => {
  let accountExpires = params.accountExpires ?? null;
  if (params.accountExpires === undefined) {
    const configured = await settings.get<number | null>("user.account.local_guest_expires_days");
    const days = typeof configured === "number" ? configured : 365;
    accountExpires = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  }

  return create({
    data: {
      email: params.email,
      givenname: params.givenname,
      sn: params.sn,
      displayName: params.displayName,
    },
    profile: "guest",
    accountExpires,
  });
};

export const update = async (params: {
  id: string;
  data: {
    givenname?: string;
    sn?: string;
    displayName?: string;
    mail?: string;
  };
}): Promise<MutationResult<void>> => {
  const existingRows = await sql<DbRow[]>`SELECT id FROM auth.users WHERE id = ${params.id}::uuid AND provider = 'local'`;
  if (existingRows.length === 0) {
    return { ok: false, error: "Local user not found", status: 404 };
  }

  await sql`
    UPDATE auth.users
    SET given_name = CASE WHEN ${params.data.givenname !== undefined} THEN ${params.data.givenname ?? ""} ELSE given_name END,
        sn = CASE WHEN ${params.data.sn !== undefined} THEN ${params.data.sn ?? ""} ELSE sn END,
        display_name = CASE WHEN ${params.data.displayName !== undefined} THEN ${params.data.displayName ?? ""} ELSE display_name END,
        mail = CASE WHEN ${params.data.mail !== undefined} THEN ${params.data.mail ?? null} ELSE mail END
    WHERE id = ${params.id}::uuid
  `;

  return { ok: true, data: undefined };
};

export const setProfile = async (params: {
  id: string;
  profile: UserProfile;
  accountExpires: Date | null;
  actor?: AuditActor;
}): Promise<MutationResult<void>> => {
  const result = await writeLocalAccount(async (tx) => {
    const rows = await tx<{ provider: string; profile: UserProfile; admin: boolean }[]>`
    SELECT provider, profile, admin
    FROM auth.users
    WHERE id = ${params.id}::uuid
  `;
    if (rows.length === 0) return { ok: false, error: "User not found", status: 404 };
    if (rows[0]!.provider !== "local") {
      return { ok: false, error: "Only local accounts can change profile locally", status: 400 };
    }

    const admin = resolveStoredAdminState({
      provider: "local",
      profile: params.profile,
      currentAdmin: Boolean(rows[0]!.admin),
    });

    await tx`
    UPDATE auth.users
    SET provider = 'local',
        profile = ${params.profile},
        admin = ${admin},
        account_expires = ${params.accountExpires}
    WHERE id = ${params.id}::uuid
  `;

    return { ok: true, data: { id: params.id, assignIdentity: rows[0]!.profile === "guest" && params.profile === "user" } };
  }, params.actor);
  return result.ok ? { ok: true, data: undefined } : result;
};

export const setExpiry = async (params: {
  id: string;
  profile: UserProfile;
  accountExpires: Date | null;
}): Promise<MutationResult<void>> => {
  const rows = await sql<DbRow[]>`
    SELECT provider
    FROM auth.users
    WHERE id = ${params.id}::uuid
  `;
  if (rows.length === 0) return { ok: false, error: "User not found", status: 404 };
  if ((rows[0]!.provider as string) !== "local") {
    return { ok: false, error: "Only local accounts support local expiry changes", status: 400 };
  }

  await sql`
    UPDATE auth.users
    SET account_expires = ${params.accountExpires}
    WHERE id = ${params.id}::uuid
  `;

  return { ok: true, data: undefined };
};

export const setAdmin = async (params: { id: string; admin: boolean }): Promise<MutationResult<void>> => {
  const rows = await sql<DbRow[]>`
    SELECT provider, profile, admin
    FROM auth.users
    WHERE id = ${params.id}::uuid
  `;
  if (rows.length === 0) return { ok: false, error: "User not found", status: 404 };
  const row = rows[0]!;
  if ((row.provider as string) !== "local") {
    return { ok: false, error: "Only local full accounts can be granted admin access", status: 400 };
  }
  if ((row.profile as string) !== "user") {
    return { ok: false, error: "Guest accounts cannot be granted admin access", status: 400 };
  }
  const currentAdmin = Boolean(row.admin);
  if (currentAdmin === params.admin) {
    return { ok: false, error: params.admin ? "Account is already an admin" : "Account is not an admin", status: 409 };
  }

  await sql`
    UPDATE auth.users
    SET admin = ${params.admin}
    WHERE id = ${params.id}::uuid
  `;

  return { ok: true, data: undefined };
};

export const remove = async (params: { id: string; actor: { userId: string; uid: string } }): Promise<MutationResult<void>> => {
  const rows = await sql<DbRow[]>`
    SELECT uid, profile, mail, display_name
    FROM auth.users
    WHERE id = ${params.id}::uuid
      AND provider = 'local'
  `;
  if (rows.length === 0) return { ok: false, error: "Local user not found", status: 404 };

  const row = rows[0]!;
  const uid = row.uid as string;
  await sql.begin(async (tx) => {
    await writeDeletedAccountAudit({
      db: tx,
      userId: params.id,
      uid,
      mail: (row.mail as string) ?? null,
      displayName: (row.display_name as string) ?? null,
      previousProvider: "local",
      previousProfile: (row.profile as UserProfile | null) ?? "guest",
      reason: "manual_delete",
      meta: {
        actorUserId: params.actor.userId,
        actorUid: params.actor.uid,
        deletedFromFreeIpa: false,
        freeIpaUserAlreadyMissing: false,
      },
    });
    await tx`DELETE FROM auth.users WHERE id = ${params.id}::uuid`;
  });

  await session.revokeAllForUser(params.id);

  return { ok: true, data: undefined };
};
