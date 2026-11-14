import { coreUserEventPublisher } from "../../events/core-user-created";
import { sql } from "../../runtime/clients";
import { freeipa } from "../../server/services";
import { writeDeletedAccountAudit } from "../account-lifecycle/audit";
import { calculateIpaProfileFromGroupNames, parseIpaAccountTransitionPolicy, parseIpaMatchMode } from "../account-model";
import { applyIpaAccountTransitionPolicy } from "../accounts/switching";
import { getFreeIpaConfig } from "../freeipa-config";
import { logger } from "../logging";
import { session } from "../session";
import * as settings from "../settings";
import { buildEffectiveIpaGroupsByUid } from "./effective-groups";
import { mirrorIpaPosix } from "./posix";
import { calculateIpaProfileFromEffectiveProjection, getEffectiveUserGroups } from "./profile";
import { ipaEntryId } from "./reactivation";
import { createIpaRuntimeCheckpoint, type IpaSyncRuntime } from "./runtime";
import {
  assessIpaDestructionGuard,
  createIpaIdentityMatcher,
  formatIpaDestructionGuardFailure,
  readCompleteIpaList,
  selectStaleLocalIpaRows,
} from "./sync-planning";

type DbRow = Record<string, unknown>;
type LocalIpaRow = DbRow & { id: string; uid: string; mail: string | null; entryId: string | null };

const log = logger("auth:ipa:sync");

/** Preserve database microseconds: a Date can reorder this read before a lock from the same millisecond. */
const observationStart = async (): Promise<string> =>
  (await sql<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)[0]!.now;

/**
 * Records that FreeIPA locks an account (nsaccountlock); true when the lock is new. `locked_at` is the latest lock
 * observation, so a read that started before it never lifts the lock. A new lock signs the account out everywhere
 * (sessions, user OAuth tokens, phones, sign-in devices) in the same transaction, so lifting it later revives nothing.
 * Takes the account row first: lock records and transitions of one account run one after another.
 */
const recordIpaLock = async (db: typeof sql, userId: string): Promise<boolean> => {
  await db`SELECT id FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE`;
  const [previous] = await db<{ locked: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM auth.user_ipa_data WHERE user_id = ${userId}::uuid AND locked_at IS NOT NULL) AS locked
  `;
  await db`
    INSERT INTO auth.user_ipa_data (user_id, locked_at) VALUES (${userId}::uuid, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE SET locked_at = EXCLUDED.locked_at
  `;
  if (previous?.locked) return false;
  await session.revokeAllForUserInTransaction(db, userId);
  return true;
};

/** True when a lock of the account was observed after `observedAt`: a transition based on that older read must wait. */
const lockedSince = async (db: typeof sql, userId: string, observedAt: string): Promise<boolean> => {
  await db`SELECT id FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE`;
  const [row] = await db<{ locked: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM auth.user_ipa_data WHERE user_id = ${userId}::uuid AND locked_at >= ${observedAt}::timestamptz) AS locked
  `;
  return row?.locked === true;
};

/** Upserts the IPA mirror; true when it records a new lock. An unlocked observation lifts only older locks. */
const upsertUserIpaData = async (
  db: typeof sql,
  params: {
    userId: string;
    entryId: string | null;
    uidNumber: number | null;
    primaryGidNumber: number | null;
    homeDirectory: string | null;
    loginShell: string | null;
    phone: string | null;
    ipaPasswordExpires: Date | null;
    lastLoginIpa: Date | null;
    employeeType: string | null;
    addrStreet: string | null;
    addrPostalCode: string | null;
    addrCity: string | null;
    addrState: string | null;
    mobile: string | null;
    sshPublicKeys: string[];
    sshFingerprints: string[];
    locked: boolean;
    observedAt: string;
  },
): Promise<boolean> => {
  await mirrorIpaPosix(db, params);
  await db`
    INSERT INTO auth.user_ipa_data (
      user_id, ipa_entry_id, uid_number, phone, employee_type, mobile, addr_street, addr_postal_code,
      addr_city, addr_state, ipa_password_expires, last_login_ipa, synced_at, ssh_public_keys, ssh_fingerprints
    )
    VALUES (
      ${params.userId},
      ${params.entryId},
      ${params.uidNumber},
      ${params.phone},
      ${params.employeeType},
      ${params.mobile},
      ${params.addrStreet},
      ${params.addrPostalCode},
      ${params.addrCity},
      ${params.addrState},
      ${params.ipaPasswordExpires},
      ${params.lastLoginIpa},
      now(),
      ${freeipa.util.toPgTextArray(params.sshPublicKeys)}::text[],
      ${freeipa.util.toPgTextArray(params.sshFingerprints)}::text[]
    )
    ON CONFLICT (user_id) DO UPDATE SET
      ipa_entry_id = COALESCE(auth.user_ipa_data.ipa_entry_id, EXCLUDED.ipa_entry_id),
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
      ssh_fingerprints = EXCLUDED.ssh_fingerprints,
      locked_at = CASE
        WHEN ${params.locked} OR auth.user_ipa_data.locked_at >= ${params.observedAt}::timestamptz THEN auth.user_ipa_data.locked_at
        ELSE NULL
      END
  `;
  return params.locked && (await recordIpaLock(db, params.userId));
};

/**
 * Locks the account row and returns its stored directory entry ID; undefined when the account no longer exists.
 * A match from an earlier read must be checked again here: a concurrent sign-in may have bound the account meanwhile.
 */
const lockAccountIdentity = async (db: typeof sql, userId: string): Promise<{ entryId: string | null } | undefined> => {
  const [account] = await db`SELECT id FROM auth.users WHERE id = ${userId}::uuid AND provider = 'ipa' FOR UPDATE`;
  if (!account) return undefined;
  // A separate statement after the lock: it sees a binding that the previous lock holder committed.
  const [mirror] = await db<{ ipa_entry_id: string | null }[]>`
    SELECT ipa_entry_id FROM auth.user_ipa_data WHERE user_id = ${userId}::uuid
  `;
  return { entryId: mirror?.ipa_entry_id ?? null };
};

/** Stores the directory entry ID of an account that has none yet, unless another account already holds it. */
const bindIpaEntryId = async (db: typeof sql, userId: string, entryId: string | null): Promise<void> => {
  if (!entryId) return;
  await db`
    UPDATE auth.user_ipa_data SET ipa_entry_id = ${entryId}
    WHERE user_id = ${userId}::uuid AND ipa_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM auth.user_ipa_data WHERE ipa_entry_id = ${entryId})
  `;
};

/**
 * True when another FreeIPA account in Cloud already uses this exact email. Email never identifies a directory
 * user; a duplicate is a conflict for administrators, and the account keeps its previous email meanwhile.
 */
const ipaMailHeldByOther = async (db: typeof sql, mail: string | null, userId: string | null): Promise<boolean> => {
  if (!mail) return false;
  const rows = await db`
    SELECT 1 FROM auth.users
    WHERE provider = 'ipa' AND mail = ${mail} AND (${userId}::uuid IS NULL OR id <> ${userId}::uuid)
    LIMIT 1
  `;
  return rows.length > 0;
};

// ==========================
// Sync Types
// ==========================

type SyncUser = {
  uid: string;
  /** FreeIPA's immutable entry ID (ipaUniqueID); it survives a rename, a username does not identify a person. */
  entryId: string | null;
  uidNumber: number | null;
  primaryGidNumber: number | null;
  homeDirectory: string | null;
  loginShell: string | null;
  givenname: string;
  sn: string;
  displayName: string;
  mail: string | null;
  phone: string | null;
  ipaAccountExpires: Date | null;
  ipaPasswordExpires: Date | null;
  lastLoginIpa: Date | null;
  memberofGroup: string[];
  employeeType: string | null;
  addrStreet: string | null;
  addrPostalCode: string | null;
  addrCity: string | null;
  addrState: string | null;
  mobile: string | null;
  sshPublicKeys: string[];
  sshFingerprints: string[];
  /** FreeIPA's nsaccountlock: the directory refuses this account. */
  locked: boolean;
};

type SyncGroup = {
  cn: string;
  description: string | null;
  gidnumber: number | null;
  users: string[];
  groups: string[];
  parentGroups: string[];
  managerUsers: string[];
  managerGroups: string[];
};

// ==========================
// Transform helpers
// ==========================

/**
 * Normalizes one raw IPA user record into the sync user model.
 */
const transformSyncUser = (raw: Record<string, unknown>): SyncUser => {
  const directGroups = (raw.memberof_group as string[]) ?? [];
  const indirectGroups = (raw.memberofindirect_group as string[]) ?? [];
  return {
    uid: freeipa.util.str(raw.uid),
    entryId: ipaEntryId(raw),
    uidNumber: freeipa.util.num(raw.uidnumber),
    primaryGidNumber: freeipa.util.num(raw.gidnumber),
    homeDirectory: freeipa.util.str(raw.homedirectory) || null,
    loginShell: freeipa.util.str(raw.loginshell) || null,
    givenname: freeipa.util.str(raw.givenname),
    sn: freeipa.util.str(raw.sn),
    displayName:
      freeipa.util.str(raw.displayname) ||
      [freeipa.util.str(raw.givenname), freeipa.util.str(raw.sn)].filter(Boolean).join(" ") ||
      freeipa.util.str(raw.uid),
    mail: freeipa.util.str(raw.mail) || null,
    phone: freeipa.util.str(raw.telephonenumber) || null,
    ipaAccountExpires: freeipa.util.parseGeneralizedTime(raw.krbprincipalexpiration),
    ipaPasswordExpires: freeipa.util.parseGeneralizedTime(raw.krbpasswordexpiration),
    lastLoginIpa: freeipa.util.parseGeneralizedTime(raw.krblastsuccessfulauth),
    memberofGroup: [...directGroups, ...indirectGroups],
    employeeType: freeipa.util.str(raw.employeetype) || null,
    addrStreet: freeipa.util.str(raw.street) || null,
    addrPostalCode: freeipa.util.str(raw.postalcode) || null,
    addrCity: freeipa.util.str(raw.l) || null,
    addrState: freeipa.util.str(raw.st) || null,
    mobile: freeipa.util.str(raw.mobile) || null,
    sshPublicKeys: Array.isArray(raw.ipasshpubkey) ? raw.ipasshpubkey : [],
    sshFingerprints: Array.isArray(raw.sshpubkeyfp) ? raw.sshpubkeyfp : [],
    locked: freeipa.util.str(raw.nsaccountlock).toLowerCase() === "true",
  };
};

/**
 * Normalizes one raw IPA group record into the sync group model.
 * `excludedGroupsSet` is hoisted to the caller so we don't re-read settings
 * once per group.
 */
const transformSyncGroup = (raw: Record<string, unknown>, excludedGroupsSet: Set<string> = new Set()): SyncGroup => ({
  cn: freeipa.util.str(raw.cn),
  description: freeipa.util.str(raw.description) || null,
  gidnumber: freeipa.util.num(raw.gidnumber),
  users: (raw.member_user as string[]) ?? [],
  groups: ((raw.member_group as string[]) ?? []).filter((g) => !excludedGroupsSet.has(g)),
  parentGroups: ((raw.memberof_group as string[]) ?? []).filter((g) => !excludedGroupsSet.has(g)),
  managerUsers: (raw.membermanager_user as string[]) ?? [],
  managerGroups: ((raw.membermanager_group as string[]) ?? []).filter((g) => !excludedGroupsSet.has(g)),
});

/**
 * Evaluates whether an IPA account is already expired based on account metadata.
 */
const isExpired = (u: SyncUser): boolean => {
  if (!u.ipaAccountExpires) return false;
  return u.ipaAccountExpires < new Date();
};

/**
 * Reads one IPA list response and throws for transport/protocol failures.
 * Sync must fail hard on invalid payloads to avoid destructive partial updates.
 */
// ==========================
// Sync
// ==========================

/**
 * Runs a full IPA-to-local sync pass for users, groups, and memberships.
 */
export const syncFromIpa = async (runtime: IpaSyncRuntime = {}): Promise<void> => {
  const startedAt = Date.now();
  let leaseHeartbeats = 0;
  const runCheckpoint = createIpaRuntimeCheckpoint(runtime, {
    onHeartbeat: () => {
      leaseHeartbeats += 1;
    },
  });
  const config = await getFreeIpaConfig();
  if (!config.enabled) {
    log.info("Sync skipped", { reason: "freeipa_disabled" });
    return;
  }
  if (!config.configured) {
    throw new Error(`FreeIPA is enabled but not fully configured. Missing: ${config.missingSettings.join(", ")}.`);
  }
  const excludedGroupsSet = freeipa.util.toExcludedGroupsSet(config.groupsExcluded);
  const ipaSession = await freeipa.session.getServiceSession({
    url: config.url,
    serviceUser: config.serviceUser,
    servicePassword: config.servicePassword,
    signal: runtime.signal,
  });
  await runCheckpoint(true);

  const observedAt = await observationStart();
  const snapshotFetchStartedAt = Date.now();
  const [usersRes, groupsRes] = await Promise.all([
    freeipa.client.call({
      url: config.url,
      ipaSession,
      method: "user_find",
      args: [],
      options: { sizelimit: 0, all: true },
      signal: runtime.signal,
    }),
    freeipa.client.call({
      url: config.url,
      ipaSession,
      method: "group_find",
      args: [],
      options: {
        sizelimit: 0,
        no_members: false,
        all: true,
      },
      signal: runtime.signal,
    }),
  ]);
  const snapshotFetchDurationMs = Date.now() - snapshotFetchStartedAt;
  await runCheckpoint(true);

  const allRawUsers = readCompleteIpaList({ response: usersRes, entity: "users" });
  const allUsers = allRawUsers.map(transformSyncUser);
  const allRawGroups = readCompleteIpaList({ response: groupsRes, entity: "groups" });
  const effectiveGroupsByUid = buildEffectiveIpaGroupsByUid(allRawGroups.map((raw) => transformSyncGroup(raw)));
  const users = allUsers.filter((user) => {
    const effectiveGroups = effectiveGroupsByUid.get(user.uid) ?? [];
    return config.groupsBaseSync.some((group) => effectiveGroups.includes(group));
  });
  const groups = allRawGroups.map((raw) => transformSyncGroup(raw, excludedGroupsSet)).filter((g) => !excludedGroupsSet.has(g.cn));

  const activeUsers = users.filter((u) => !isExpired(u));
  const expiredUsers = users.length - activeUsers.length;
  // Only ACTIVE remote users are considered in scope. Expired ones fall through to the
  // stale/transition branch so their local mirror is either demoted or deleted per policy,
  // and their sessions are revoked. Treating expired users as in-scope would leave a stale
  // unexpired local row plus live sessions.
  const groupCns = new Set(groups.map((g) => g.cn));
  const matchMode = parseIpaMatchMode(await settings.get<string | null>("freeipa.user_match_mode"));
  const transitionPolicy = parseIpaAccountTransitionPolicy(await settings.get<string | null>("freeipa.account_transition_policy"));

  let renamedUsers = 0;
  let boundDirectoryIdentities = 0;
  let directoryIdentityConflicts = 0;
  let mailConflicts = 0;
  let proposedLocalMigrations = 0;
  let skippedLocalMailConflicts = 0;
  let skippedLocalUidConflicts = 0;
  let upsertedUsersByUid = 0;
  let insertedUsersByUid = 0;
  let updatedUsersByUid = 0;
  let deletedGroups = 0;

  const localIpaRows = (
    await sql<DbRow[]>`
      SELECT u.id, u.uid, u.mail, u.display_name, u.profile, ui.ipa_entry_id
      FROM auth.users u
      LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id
      WHERE u.provider = 'ipa'
      ORDER BY u.uid
    `
  ).map(
    (row): LocalIpaRow => ({
      ...row,
      id: row.id as string,
      uid: row.uid as string,
      mail: (row.mail as string | null) ?? null,
      entryId: (row.ipa_entry_id as string | null) ?? null,
    }),
  );
  const localIpaGroupRows = await sql<DbRow[]>`
    SELECT name
    FROM auth.groups
    WHERE provider = 'ipa'
    ORDER BY name
  `;
  const localIpaUsers = localIpaRows.length;
  const localGroups = localIpaGroupRows.length;
  const matchIdentity = createIpaIdentityMatcher(localIpaRows);
  const currentRowForRemoteUser = (user: SyncUser): LocalIpaRow | undefined => {
    const match = matchIdentity(user);
    return match.kind === "matched" ? match.row : undefined;
  };
  // A lock is protective: a record without an entry ID still locks the account of its username.
  const lockedRowForRemoteUser = (user: SyncUser): LocalIpaRow | undefined => {
    const match = matchIdentity(user);
    return match.kind === "matched" || match.kind === "unverified" ? match.row : undefined;
  };
  let profileDriftCount = 0;
  const profileDriftSamples: string[] = [];
  let profilesPromoted = 0;
  let profilesDemoted = 0;
  for (const user of activeUsers) {
    const effectiveGroups = effectiveGroupsByUid.get(user.uid) ?? [];
    const graphProfile = calculateIpaProfileFromGroupNames(effectiveGroups, config.groupsBaseIpaRealm);
    const userSideProfile = calculateIpaProfileFromGroupNames(user.memberofGroup, config.groupsBaseIpaRealm);
    if (graphProfile !== userSideProfile) {
      profileDriftCount += 1;
      if (profileDriftSamples.length < 10) profileDriftSamples.push(user.uid);
    }

    const previousProfile = currentRowForRemoteUser(user)?.profile as "user" | "guest" | undefined;
    if (previousProfile === "guest" && graphProfile === "user") profilesPromoted += 1;
    if (previousProfile === "user" && graphProfile === "guest") profilesDemoted += 1;
  }

  // A locked account stays a locked FreeIPA account, also when it expired or left sync scope: a transition would
  // turn it into a local account whose passkeys and API keys work again. It transitions once FreeIPA unlocks it.
  const remoteLocked = allUsers.filter((user) => user.locked);
  const lockedRemoteByRowId = new Map(
    remoteLocked.flatMap((user) => {
      const row = lockedRowForRemoteUser(user);
      return row ? [[row.id, user] as const] : [];
    }),
  );
  const outOfScopeLocked: LocalIpaRow[] = [];
  const staleLocalUsers = selectStaleLocalIpaRows({ localRows: localIpaRows, activeRemoteUsers: activeUsers }).filter((row) => {
    if (!lockedRemoteByRowId.has(row.id)) return true;
    outOfScopeLocked.push(row);
    return false;
  });
  const newlyLocked = new Set<string>();
  const affectedUserIds = new Set(staleLocalUsers.map((row) => row.id));
  for (const user of activeUsers) {
    const previousRow = currentRowForRemoteUser(user);
    const previousProfile = previousRow?.profile as "user" | "guest" | undefined;
    const nextProfile = calculateIpaProfileFromGroupNames(effectiveGroupsByUid.get(user.uid) ?? [], config.groupsBaseIpaRealm);
    if (previousRow && previousProfile === "user" && nextProfile === "guest") {
      affectedUserIds.add(previousRow.id);
    }
  }
  const deletedGroupNames = localIpaGroupRows.map((row) => row.name as string).filter((name) => !groupCns.has(name));
  const guard = assessIpaDestructionGuard({
    affectedUserIds,
    localUsers: localIpaUsers,
    deletedGroupNames,
    localGroups,
    limits: config.syncGuard,
  });
  log.info("IPA sync destructive plan assessed", guard);
  if (guard.violations.length > 0) throw new Error(formatIpaDestructionGuardFailure(guard));
  if (profilesDemoted > 0) {
    log.warn("IPA sync will downgrade user profiles", { profilesDemoted });
  }
  if (profileDriftCount > 0) {
    log.warn("IPA user memberOf drift detected; using group graph projection", {
      profileDriftCount,
      sampleUids: profileDriftSamples,
    });
  }

  // Revoke before the local transition so a crash after the transaction
  // cannot leave a session valid for a user that no longer appears in the next
  // IPA sync plan. A failed transaction may require a relogin, which is the
  // safe side of this cross-store boundary.
  for (const staleUser of staleLocalUsers) {
    await runCheckpoint();
    await session.revokeAllForUser(staleUser.id as string);
  }

  let scopeTransitions = 0;
  let effectiveGroupsRebuilt = 0;
  await runCheckpoint(true);
  const transactionStartedAt = Date.now();
  await sql.begin(async (tx) => {
    // 1. Upsert active IPA users by directory identity (entry ID, else username for an unbound account).
    //    Email never selects an account: a shared or reused address is reported as a conflict instead.
    const claimedRowIds = new Set<string>();
    const seenEntryIds = new Set<string>();
    // Directory username -> account, only for identities verified here; memberships below follow this map.
    const syncedUserIdByUid = new Map<string, string>();
    for (let userIndex = 0; userIndex < activeUsers.length; userIndex += 1) {
      await runCheckpoint();
      const u = activeUsers[userIndex]!;
      const effectiveGroups = effectiveGroupsByUid.get(u.uid) ?? [];
      const profile = calculateIpaProfileFromGroupNames(effectiveGroups, config.groupsBaseIpaRealm);
      const provider = "ipa";
      const match = matchIdentity(u);
      const duplicateEntry = u.entryId !== null && seenEntryIds.has(u.entryId);
      if (u.entryId) seenEntryIds.add(u.entryId);

      if (match.kind === "unverified") {
        directoryIdentityConflicts += 1;
        log.warn("Skipping IPA sync user: the directory returned no entry ID for a bound account", { uid: u.uid, userId: match.row.id });
        if (u.locked && (await recordIpaLock(tx, match.row.id))) newlyLocked.add(match.row.id);
        continue;
      }

      if (duplicateEntry || match.kind === "conflict" || (match.kind === "matched" && claimedRowIds.has(match.row.id))) {
        directoryIdentityConflicts += 1;
        log.warn("Skipping IPA sync user: the username belongs to another directory entry", {
          uid: u.uid,
          userId: match.kind === "none" ? null : match.row.id,
        });
        // A duplicate record of the same identity still locks its account.
        if (match.kind === "matched" && u.locked && (await recordIpaLock(tx, match.row.id))) newlyLocked.add(match.row.id);
        continue;
      }

      if (match.kind === "matched") {
        const row = match.row;
        claimedRowIds.add(row.id);
        const current = await lockAccountIdentity(tx, row.id);
        if (!current || (current.entryId && current.entryId !== u.entryId)) {
          directoryIdentityConflicts += 1;
          log.warn("Skipping IPA sync user: its account changed during the sync", { uid: u.uid, userId: row.id });
          continue;
        }
        if (row.uid !== u.uid) {
          const [holder] = await tx<DbRow[]>`SELECT id FROM auth.users WHERE uid = ${u.uid} AND id <> ${row.id}::uuid LIMIT 1`;
          if (holder) {
            directoryIdentityConflicts += 1;
            log.warn("Skipping IPA sync rename: another account already uses the new username", {
              uid: u.uid,
              previousUid: row.uid,
              userId: row.id,
              holderUserId: holder.id,
            });
            // The account keeps its identity; a lock must still reach it.
            if (u.locked && (await recordIpaLock(tx, row.id))) newlyLocked.add(row.id);
            syncedUserIdByUid.set(u.uid, row.id);
            continue;
          }
        }
        const keepMail = await ipaMailHeldByOther(tx, u.mail, row.id);
        if (keepMail) {
          mailConflicts += 1;
          log.warn("IPA sync kept the previous email: another FreeIPA account uses the directory email", {
            uid: u.uid,
            userId: row.id,
          });
        }
        await tx`
          UPDATE auth.users SET
            uid = ${u.uid}, provider = ${provider}, profile = ${profile}, admin = false,
            given_name = ${u.givenname}, sn = ${u.sn}, display_name = ${u.displayName},
            mail = ${keepMail ? row.mail : u.mail},
            account_expires = ${u.ipaAccountExpires}
          WHERE id = ${row.id}::uuid`;
        if (await upsertUserIpaData(tx, { userId: row.id, ...u, observedAt })) newlyLocked.add(row.id);
        syncedUserIdByUid.set(u.uid, row.id);
        if (!current.entryId && u.entryId) boundDirectoryIdentities += 1;
        if (row.uid !== u.uid) renamedUsers += 1;
        upsertedUsersByUid += 1;
        updatedUsersByUid += 1;
        continue;
      }

      const uidConflictRows = await tx<DbRow[]>`
        SELECT id
        FROM auth.users
        WHERE uid = ${u.uid}
        LIMIT 1
      `;
      if (uidConflictRows.length > 0) {
        skippedLocalUidConflicts += 1;
        log.warn("Skipping IPA sync user upsert because another account already uses the UID", {
          uid: u.uid,
        });
        continue;
      }

      if (await ipaMailHeldByOther(tx, u.mail, null)) {
        mailConflicts += 1;
        log.warn("Skipping new IPA sync user: another FreeIPA account uses the directory email", { uid: u.uid });
        continue;
      }

      // `migrate` proposes a link only. An administrator confirms it through the account's provider switch.
      if (matchMode === "migrate" && u.mail) {
        const localMatches = await tx<DbRow[]>`
          SELECT id, uid
          FROM auth.users
          WHERE mail = ${u.mail} AND provider = 'local'
          ORDER BY profile = 'user' DESC, created_at ASC
          LIMIT 2
        `;
        if (localMatches.length === 1) {
          proposedLocalMigrations += 1;
          log.warn("IPA sync proposes linking a local account with the same email; not linked", {
            uid: u.uid,
            localUid: localMatches[0]!.uid,
            localUserId: localMatches[0]!.id,
          });
          continue;
        }
        if (localMatches.length > 1) {
          skippedLocalMailConflicts += 1;
          log.warn("Skipping IPA provider migration because multiple local accounts matched by mail", { uid: u.uid });
          continue;
        }
      }

      // A concurrent write that took the username or email skips this user until the next sync.
      const inserted = await tx<DbRow[]>`
        INSERT INTO auth.users (uid, provider, profile, admin, given_name, sn, display_name, mail, account_expires)
        VALUES (${u.uid}, ${provider}, ${profile}, false, ${u.givenname}, ${u.sn}, ${u.displayName}, ${u.mail}, ${u.ipaAccountExpires})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      const userId = inserted[0]?.id as string | undefined;
      if (!userId) {
        skippedLocalUidConflicts += 1;
        log.warn("Skipping new IPA sync user: its username or email was taken concurrently", { uid: u.uid });
        continue;
      }
      if (await upsertUserIpaData(tx, { userId, ...u, observedAt })) newlyLocked.add(userId);
      syncedUserIdByUid.set(u.uid, userId);
      upsertedUsersByUid += 1;
      insertedUsersByUid += 1;
      await coreUserEventPublisher().publish(tx, "user.created", { subject: userId, data: { userId, provider: "ipa" } });
    }

    for (const row of outOfScopeLocked) {
      await runCheckpoint();
      // A locked account outside sync scope keeps no mirrored memberships; it only records the lock.
      const remote = lockedRemoteByRowId.get(row.id)!;
      if (await recordIpaLock(tx, row.id)) newlyLocked.add(row.id);
      if (matchIdentity(remote).kind === "matched") await bindIpaEntryId(tx, row.id, remote.entryId);
    }

    for (let staleIndex = 0; staleIndex < staleLocalUsers.length; staleIndex += 1) {
      await runCheckpoint();
      const stale = staleLocalUsers[staleIndex]!;
      const userId = stale.id as string;
      const uid = stale.uid as string;
      const previousProfile = (stale.profile as "user" | "guest" | null) ?? "guest";
      // A lock seen after this snapshot keeps the account; the next sync decides with the newer state.
      if (await lockedSince(tx, userId, observedAt)) continue;

      if (transitionPolicy === "delete") {
        await writeDeletedAccountAudit({
          db: tx,
          userId,
          uid,
          mail: (stale.mail as string) ?? null,
          displayName: (stale.display_name as string) ?? null,
          previousProvider: "ipa",
          previousProfile,
          reason: "sync_out_of_scope_deleted",
          meta: {
            reason: "missing_from_ipa_sync_scope",
          },
        });
        await tx`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
        scopeTransitions += 1;
        continue;
      }

      // A local account with the same email blocks the move to a local account: report it and keep the rest going.
      // The account stays signed out and outside sync scope until an administrator resolves the duplicate.
      if (stale.mail) {
        const [localHolder] = await tx<DbRow[]>`
          SELECT id FROM auth.users WHERE provider = 'local' AND mail = ${stale.mail} AND id <> ${userId}::uuid LIMIT 1
        `;
        if (localHolder) {
          mailConflicts += 1;
          log.warn("Deferring IPA account transition: a local account uses the same email", {
            uid,
            userId,
            localUserId: localHolder.id,
          });
          continue;
        }
      }

      const target = await applyIpaAccountTransitionPolicy({
        userId,
        currentProfile: previousProfile,
        policy: transitionPolicy,
        db: tx,
      });
      await writeDeletedAccountAudit({
        db: tx,
        userId,
        uid,
        mail: (stale.mail as string) ?? null,
        displayName: (stale.display_name as string) ?? null,
        previousProvider: "ipa",
        previousProfile,
        reason: "sync_out_of_scope_demoted",
        meta: {
          accountExpiresAt: target.accountExpires?.toISOString() ?? null,
          targetProfile: target.targetProfile,
          reason: "missing_from_ipa_sync_scope",
        },
      });
      scopeTransitions += 1;
    }

    // 2. Upsert groups + delete stale
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      await runCheckpoint();
      const g = groups[groupIndex]!;
      await tx`
        INSERT INTO auth.groups (id, cn, name, provider, description, gid_number, synced_at)
        VALUES (gen_random_uuid(), ${g.cn}, ${g.cn}, 'ipa', ${g.description}, ${g.gidnumber}, now())
        ON CONFLICT (provider, name) DO UPDATE SET
          cn = EXCLUDED.cn,
          description = EXCLUDED.description,
          gid_number = EXCLUDED.gid_number,
          synced_at = now()`;
    }
    const groupCnArray = [...groupCns];
    if (groupCnArray.length > 0) {
      const deleted = await tx<DbRow[]>`
        DELETE FROM auth.groups
        WHERE provider = 'ipa'
          AND name <> ALL(${freeipa.util.toPgTextArray(groupCnArray)}::text[])
        RETURNING name
      `;
      deletedGroups = deleted.length;
    } else {
      const deleted = await tx<DbRow[]>`
        DELETE FROM auth.groups
        WHERE provider = 'ipa'
        RETURNING name
      `;
      deletedGroups = deleted.length;
    }

    const groupRows = await tx<DbRow[]>`SELECT id, name FROM auth.groups WHERE provider = 'ipa'`;
    const groupNameToId = new Map<string, string>(groupRows.map((row) => [row.name as string, row.id as string]));

    // 3. Rebuild junction tables
    await tx`DELETE FROM auth.user_groups_v2 WHERE group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')`;
    await tx`
      DELETE FROM auth.group_groups_v2
      WHERE parent_group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')
         OR child_group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')
    `;
    await tx`DELETE FROM auth.group_manager_users_v2 WHERE group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')`;
    await tx`
      DELETE FROM auth.group_manager_groups_v2
      WHERE group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')
         OR manager_group_id IN (SELECT id FROM auth.groups WHERE provider = 'ipa')
    `;

    const uidToId = syncedUserIdByUid;

    await tx`
      DELETE FROM auth.ipa_user_effective_groups
      WHERE user_id IN (SELECT id FROM auth.users WHERE provider = 'ipa')
    `;
    const effectiveGroupRows: { user_id: string; group_name: string }[] = [];
    for (const [uid, groupNames] of effectiveGroupsByUid) {
      const userId = uidToId.get(uid);
      if (!userId) continue;
      for (const groupName of groupNames) {
        effectiveGroupRows.push({ user_id: userId, group_name: groupName });
      }
    }
    if (effectiveGroupRows.length > 0) {
      await runCheckpoint();
      await tx`INSERT INTO auth.ipa_user_effective_groups ${sql(effectiveGroupRows, "user_id", "group_name")} ON CONFLICT DO NOTHING`;
    }
    effectiveGroupsRebuilt = effectiveGroupRows.length;

    // Bulk INSERT helper. Bun's `sql(rows)` only generates valid VALUES
    // syntax when fed an array of OBJECTS (it derives the column list from
    // object keys). Passing array-of-arrays produces broken SQL like
    // `VALUES ("0", "1") VALUES($1, $2),...` — see Bun postgres bug. So we
    // build typed objects and use the column-form `sql(rows, "col_a", "col_b")`
    // to control column ordering explicitly.

    // user_groups — built from group's member_user (authoritative source)
    const userGroupRows: { user_id: string; group_id: string }[] = [];
    for (const g of groups) {
      const groupId = groupNameToId.get(g.cn);
      if (!groupId) continue;
      for (const uid of g.users) {
        const userId = uidToId.get(uid);
        if (userId) userGroupRows.push({ user_id: userId, group_id: groupId });
      }
    }
    if (userGroupRows.length > 0) {
      await runCheckpoint();
      await tx`INSERT INTO auth.user_groups_v2 ${sql(userGroupRows, "user_id", "group_id")} ON CONFLICT DO NOTHING`;
    }

    // group_groups + manager junctions
    const groupGroupRows: { parent_group_id: string; child_group_id: string }[] = [];
    const managerUserRows: { group_id: string; user_id: string }[] = [];
    const managerGroupRows: { group_id: string; manager_group_id: string }[] = [];
    for (const g of groups) {
      const groupId = groupNameToId.get(g.cn);
      if (!groupId) continue;
      for (const child of g.groups) {
        const childGroupId = groupNameToId.get(child);
        if (childGroupId) groupGroupRows.push({ parent_group_id: groupId, child_group_id: childGroupId });
      }
      for (const uid of g.managerUsers) {
        const userId = uidToId.get(uid);
        if (userId) managerUserRows.push({ group_id: groupId, user_id: userId });
      }
      for (const mgr of g.managerGroups) {
        const managerGroupId = groupNameToId.get(mgr);
        if (managerGroupId) managerGroupRows.push({ group_id: groupId, manager_group_id: managerGroupId });
      }
    }
    if (groupGroupRows.length > 0) {
      await runCheckpoint();
      await tx`INSERT INTO auth.group_groups_v2 ${sql(groupGroupRows, "parent_group_id", "child_group_id")} ON CONFLICT DO NOTHING`;
    }
    if (managerUserRows.length > 0) {
      await tx`INSERT INTO auth.group_manager_users_v2 ${sql(managerUserRows, "group_id", "user_id")} ON CONFLICT DO NOTHING`;
    }
    if (managerGroupRows.length > 0) {
      await tx`INSERT INTO auth.group_manager_groups_v2 ${sql(managerGroupRows, "group_id", "manager_group_id")} ON CONFLICT DO NOTHING`;
    }
  });
  const transactionDurationMs = Date.now() - transactionStartedAt;

  log.info("Sync complete", {
    durationMs: Date.now() - startedAt,
    snapshotFetchDurationMs,
    transactionDurationMs,
    leaseHeartbeats,
    remoteUsersFetched: allRawUsers.length,
    remoteUsersInScope: users.length,
    remoteExpiredUsers: expiredUsers,
    remoteLockedUsers: remoteLocked.length,
    newlyLockedUsers: newlyLocked.size,
    activeUsersSynced: activeUsers.length,
    renamedUsers,
    boundDirectoryIdentities,
    directoryIdentityConflicts,
    mailConflicts,
    proposedLocalMigrations,
    skippedLocalMailConflicts,
    skippedLocalUidConflicts,
    staleUsersDemoted: scopeTransitions,
    scopeTransitions,
    profileDriftCount,
    profilesPromoted,
    profilesDemoted,
    effectiveGroupsRebuilt,
    upsertedUsersByUid,
    insertedUsersByUid,
    updatedUsersByUid,
    groupsSynced: groups.length,
    deletedGroups,
    localIpaUsersBefore: localIpaUsers,
    localGroupsBefore: localGroups,
    destructiveUserChanges: guard.userChanges,
    destructiveUserChangePercent: guard.userChangePercent,
    destructiveGroupDeletions: guard.groupDeletions,
    destructiveGroupDeletionPercent: guard.groupDeletionPercent,
    destructionGuardLimits: guard.limits,
  });
};

/**
 * Outcome of a single-user sync attempt. The login flow must reject any outcome
 * other than `synced`; stale mirror state must never grant a fresh session when
 * FreeIPA says the user is expired, missing, or out of sync scope.
 */
export type SyncUserOutcome =
  | { status: "synced"; userId: string }
  | { status: "skipped_disabled" }
  | { status: "fetch_failed"; error: string }
  | { status: "expired"; userId: string | null }
  | { status: "locked"; userId: string | null }
  | { status: "out_of_scope"; userId: string | null }
  | { status: "not_found_local" };

/**
 * Reconcile a local IPA mirror row after discovering the remote user is no
 * longer valid because the IPA account is expired. Full sync also uses this
 * transition policy for graph-derived out-of-scope users; single-user sync does
 * not demote based on FreeIPA user-side memberOf data.
 */
const reconcileOutOfScopeUser = async (params: {
  userId: string;
  uid: string;
  mail: string | null;
  displayName: string | null;
  previousProfile: "user" | "guest";
  reason: "ipa_expired_demoted" | "ipa_expired_deleted" | "sync_out_of_scope_demoted" | "sync_out_of_scope_deleted";
  meta?: Record<string, unknown>;
  observedAt: string;
}): Promise<void> => {
  const transitionPolicy = parseIpaAccountTransitionPolicy(await settings.get<string | null>("freeipa.account_transition_policy"));

  await session.revokeAllForUser(params.userId);
  await sql.begin(async (tx) => {
    // A lock seen after this read keeps the account as a locked FreeIPA account.
    if (await lockedSince(tx, params.userId, params.observedAt)) return;
    if (transitionPolicy === "delete") {
      await writeDeletedAccountAudit({
        db: tx,
        userId: params.userId,
        uid: params.uid,
        mail: params.mail,
        displayName: params.displayName,
        previousProvider: "ipa",
        previousProfile: params.previousProfile,
        reason: params.reason.endsWith("_demoted")
          ? (params.reason.replace("_demoted", "_deleted") as typeof params.reason)
          : params.reason,
        meta: params.meta ?? {},
      });
      await tx`DELETE FROM auth.users WHERE id = ${params.userId}::uuid`;
      return;
    }

    const target = await applyIpaAccountTransitionPolicy({
      userId: params.userId,
      currentProfile: params.previousProfile,
      policy: transitionPolicy,
      db: tx,
    });
    await writeDeletedAccountAudit({
      db: tx,
      userId: params.userId,
      uid: params.uid,
      mail: params.mail,
      displayName: params.displayName,
      previousProvider: "ipa",
      previousProfile: params.previousProfile,
      reason: params.reason,
      meta: {
        ...(params.meta ?? {}),
        accountExpiresAt: target.accountExpires?.toISOString() ?? null,
        targetProfile: target.targetProfile,
      },
    });
  });
};

/**
 * Sync a single user's attributes from FreeIPA.
 * Called on login to ensure time-sensitive data is up-to-date.
 *
 * IMPORTANT: Only syncs user attributes (name, mail, expiry, aliases).
 * Does NOT sync group memberships. Scope/profile come from the last full-sync
 * effective group projection; user-side memberOf drift is logged but never used
 * for destructive transitions here.
 *
 * Returns a typed outcome so callers (notably `authFlows.ipa.login`) can decide
 * whether to grant a session. Expired users are reconciled immediately; group
 * scope changes are handled by full sync.
 */
export const syncUser = async (username: string): Promise<SyncUserOutcome> => {
  const config = await getFreeIpaConfig();
  if (!config.enabled) {
    log.info("Single-user sync skipped", { reason: "freeipa_disabled", username });
    return { status: "skipped_disabled" };
  }
  if (!config.configured) {
    throw new Error(`FreeIPA is enabled but not fully configured. Missing: ${config.missingSettings.join(", ")}.`);
  }
  const ipaSession = await freeipa.session.getServiceSession({
    url: config.url,
    serviceUser: config.serviceUser,
    servicePassword: config.servicePassword,
  });

  // Fetch user from FreeIPA
  const observedAt = await observationStart();
  const userRes = await freeipa.client.call({
    url: config.url,
    ipaSession,
    method: "user_show",
    args: [username],
    options: { all: true },
  });
  if (userRes.error || !userRes.result?.result) {
    const error = userRes.error?.message ?? "user_show returned empty result";
    log.warn("Could not fetch user", { username, error });
    return { status: "fetch_failed", error };
  }

  const raw = userRes.result.result as Record<string, unknown>;
  const user = transformSyncUser(raw);

  const storedRow: DbRow | undefined = (
    await sql<DbRow[]>`
      SELECT u.id, u.mail, u.display_name, u.profile, ui.ipa_entry_id,
        EXISTS (
          SELECT 1 FROM auth.user_ipa_data other WHERE other.ipa_entry_id = ${user.entryId} AND other.user_id <> u.id
        ) AS entry_id_taken
      FROM auth.users u
      LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id
      WHERE u.uid = ${user.uid} AND u.provider = 'ipa'
    `
  )[0];
  // The username alone does not identify the person: an account bound to another directory entry, or an unbound
  // account whose directory entry already belongs to another account, is not this user's account.
  const storedEntryId = (storedRow?.ipa_entry_id as string | null | undefined) ?? null;
  // A record without an entry ID can neither confirm nor replace a stored one: only its lock is applied.
  const unverified = Boolean(storedEntryId) && !user.entryId;
  const identityMismatch =
    Boolean(storedRow) && !unverified && (storedEntryId ? storedEntryId !== user.entryId : storedRow?.entry_id_taken === true);
  if (identityMismatch) log.warn("Username belongs to another directory entry during single-user sync", { username });
  const existingRow = identityMismatch ? undefined : storedRow;
  const existingUserId = (existingRow?.id as string | undefined) ?? null;
  const previousProfile: "user" | "guest" = (existingRow?.profile as "user" | "guest" | undefined) ?? "guest";

  // A lock wins over expiry and scope: the account stays a locked FreeIPA account until FreeIPA unlocks it.
  if (user.locked) {
    log.warn("User locked in FreeIPA during single-user sync", { username });
    if (existingUserId)
      await sql.begin(async (tx) => {
        await recordIpaLock(tx, existingUserId);
        await bindIpaEntryId(tx, existingUserId, user.entryId);
      });
    return { status: "locked", userId: existingUserId };
  }

  if (unverified) {
    log.warn("FreeIPA returned no entry ID for a bound account during single-user sync", { username });
    return { status: "fetch_failed", error: "FreeIPA returned no directory entry ID" };
  }

  if (isExpired(user)) {
    log.warn("User expired during single-user sync", { username });
    if (existingUserId) {
      await reconcileOutOfScopeUser({
        observedAt,
        userId: existingUserId,
        uid: user.uid,
        mail: (existingRow?.mail as string | null) ?? user.mail,
        displayName: (existingRow?.display_name as string | null) ?? user.displayName,
        previousProfile,
        reason: "ipa_expired_demoted",
        meta: { accountExpiresAt: user.ipaAccountExpires?.toISOString() ?? null },
      });
    }
    return { status: "expired", userId: existingUserId };
  }

  if (!existingUserId) {
    log.warn("User not found in local DB during single-user sync", { username });
    return { status: "not_found_local" };
  }

  const effectiveGroups = await getEffectiveUserGroups(existingUserId);
  const inSyncGroups = config.groupsBaseSync.some((g) => effectiveGroups.includes(g));
  if (!inSyncGroups) {
    log.warn("User not in projected sync groups during single-user sync", {
      username,
      reason: "missing_from_last_full_sync_projection",
    });
    return { status: "out_of_scope", userId: existingUserId };
  }

  const profile = await calculateIpaProfileFromEffectiveProjection(existingUserId);
  const userSideProfile = calculateIpaProfileFromGroupNames(user.memberofGroup, config.groupsBaseIpaRealm);
  if (profile !== userSideProfile) {
    log.warn("IPA user memberOf drift detected during single-user sync", {
      username,
      projectedProfile: profile,
      userSideProfile,
    });
  }
  const provider = "ipa";

  // Update user attributes only (no group sync!)
  const synced = await sql.begin(async (tx) => {
    // Checked again under the row lock: a concurrent sync may have bound the account to another entry meanwhile.
    const current = await lockAccountIdentity(tx, existingUserId);
    if (!current || (current.entryId && current.entryId !== user.entryId)) return false;
    const keepMail = await ipaMailHeldByOther(tx, user.mail, existingUserId);
    if (keepMail) log.warn("Single-user sync kept the previous email: another FreeIPA account uses the directory email", { username });
    await tx`
      UPDATE auth.users SET
        provider = ${provider},
        profile = ${profile},
        admin = false,
        given_name = ${user.givenname},
        sn = ${user.sn},
        display_name = ${user.displayName},
        mail = ${keepMail ? ((existingRow?.mail as string | null) ?? null) : user.mail},
        account_expires = ${user.ipaAccountExpires}
      WHERE id = ${existingUserId}::uuid
    `;
    await upsertUserIpaData(tx, { userId: existingUserId, ...user, observedAt });
    return true;
  });
  if (!synced) {
    log.warn("Account changed during single-user sync", { username });
    return { status: "not_found_local" };
  }
  return { status: "synced", userId: existingUserId };
};
