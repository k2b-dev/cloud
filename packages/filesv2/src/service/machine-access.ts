import { createHash, randomBytes } from "node:crypto";
import {
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getEffectivePermission,
  hasPermission,
  type PermissionLevel,
  type Principal,
  type RequestActor,
  resolveDisplayNames,
  updateAccess,
} from "@k2b/cloud/server";
import {
  accounts,
  audit,
  isServiceAccountOAuthAuthorityCurrent,
  secrets,
  serviceAccountCredentials,
  serviceAccounts,
  toPgTextArray,
} from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import type { Binding } from "../data/bases";
import { machineStorage } from "../data/machine-storage";
import type { MachineOwner, MachineStorage } from "../machine-contracts";
import { FilesError } from "./errors";
import { relativePath } from "./paths";

const requestIds = new WeakMap<RequestActor, string>();
/** Each transport call gets its own actor object, so concurrent requests cannot share audit context. */
export function filesRequestActor(actor: RequestActor, requestId: string | null): RequestActor {
  const scoped = { ...actor };
  if (requestId) requestIds.set(scoped, requestId);
  return scoped;
}
export const principalMetadata = (actor: RequestActor) => ({
  principalType: actor.kind,
  principalId: actor.kind === "user" ? actor.user.id : actor.serviceAccount.id,
  ...(actor.kind === "service_account"
    ? { serviceAccountId: actor.serviceAccount.id, delegatedUserId: actor.delegatedUser?.id ?? null }
    : {}),
});
export const filesAuditActor = (actor: RequestActor) =>
  actor.kind === "user"
    ? { userId: actor.user.id, uid: actor.user.uid, provider: actor.user.provider, roles: actor.user.roles }
    : { uid: actor.serviceAccount.name, provider: "service_account" };
export const storageBaseId = (binding: Binding) => `${binding.area}:${binding.kind}:${binding.identity_id}`;
export const machineActor = (actor: RequestActor) =>
  actor.kind === "service_account" && ["standalone", "agent"].includes(actor.serviceAccount.kind);
export function filesScope(actor: RequestActor): PermissionLevel {
  // Personal delegated credentials keep the existing human permission contract.
  if (actor.kind === "user" || (actor.serviceAccount.kind === "user_delegated" && actor.delegatedUser)) return "admin";
  for (const level of ["admin", "write", "read"] as const)
    if (actor.scopes.includes(level) || actor.scopes.includes(`filesv2:${level}`) || actor.scopes.includes("filesv2:*")) return level;
  return "none";
}
export async function currentMachine(actor: RequestActor) {
  if (actor.kind !== "service_account" || !machineActor(actor) || actor.delegatedUser) throw new FilesError("forbidden", 403);
  return currentCredential(actor);
}
export async function currentCredential(actor: Extract<RequestActor, { kind: "service_account" }>) {
  const account = await serviceAccounts.get({ id: actor.serviceAccount.id });
  if (!account || account.status !== "active" || account.kind !== actor.serviceAccount.kind || account.kind === "resource_bound")
    throw new FilesError("forbidden", 403);
  if (account.kind === "user_delegated" && (!actor.delegatedUser || account.delegatedUserId !== actor.delegatedUser.id))
    throw new FilesError("forbidden", 403);
  if (actor.credentialExpiresAt && Date.parse(actor.credentialExpiresAt) <= Date.now()) throw new FilesError("forbidden", 403);
  if (
    actor.oauthClientId &&
    !(await isServiceAccountOAuthAuthorityCurrent({
      serviceAccountId: account.id,
      clientId: actor.oauthClientId,
      expiresAt: actor.credentialExpiresAt,
    }))
  )
    throw new FilesError("forbidden", 403);
  if (actor.credentialId) {
    const credential = await serviceAccountCredentials.getOverview({ id: actor.credentialId });
    if (
      !credential ||
      credential.serviceAccountId !== account.id ||
      credential.status !== "active" ||
      (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) ||
      actor.scopes.some((scope) => !credential.scopes.includes(scope))
    )
      throw new FilesError("forbidden", 403);
  }
  return account;
}
export const filesSubject = (actor: RequestActor): AccessSubject =>
  actor.kind === "user"
    ? { type: "user", userId: actor.user.id }
    : actor.serviceAccount.kind === "user_delegated" && actor.delegatedUser
      ? { type: "user", userId: actor.delegatedUser.id, delegatedByServiceAccountId: actor.serviceAccount.id }
      : { type: "service_account", serviceAccountId: actor.serviceAccount.id };
const principalCondition = (actor: RequestActor) =>
  buildAccessPrincipalCondition({
    subject: filesSubject(actor),
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
export async function storageCandidates(actor: RequestActor): Promise<Binding[]> {
  const [hasStorage] = await sql<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM filesv2.machine_storage) AS exists`;
  if (!hasStorage?.exists) return [];
  const principal = principalCondition(actor);
  const result: Binding[] = [];
  let after: string | null = null;
  const deadline = Date.now() + 10_000;
  do {
    if (Date.now() >= deadline) throw new FilesError("unavailable", 503);
    const rows: Binding[] = await sql<Binding[]>`SELECT b.* FROM filesv2.bases b JOIN filesv2.machine_storage m ON m.base_id=b.id
      WHERE b.lifecycle='active' AND (${after}::uuid IS NULL OR b.id>${after}::uuid)
      AND EXISTS(SELECT 1 FROM filesv2.storage_access s JOIN auth.access a ON a.id=s.access_id WHERE s.base_id=b.id AND ${principal} AND a.permission IN ('read','write','admin'))
      ORDER BY b.id LIMIT 50`;
    result.push(...rows);
    after = rows.length === 50 ? rows.at(-1)!.id : null;
  } while (after);
  return result;
}
/** Trash retains the authority of its original path, rather than acquiring an unrelated grant. */
export async function storageTrashPath(bindingId: string, path: string): Promise<string> {
  if (!path.startsWith("trash/")) return path;
  const [entry] = await sql<
    { original: string | null; trashed: string }[]
  >`SELECT original,trashed FROM filesv2.trash WHERE base_id=${bindingId}::uuid AND (trashed=${path} OR left(${path},length(trashed)+1)=trashed || '/') ORDER BY length(trashed) DESC LIMIT 1`;
  return entry?.original ? [entry.original, path.slice(entry.trashed.length).replace(/^\//, "")].filter(Boolean).join("/") : path;
}
export async function storagePermission(actor: RequestActor, binding: Binding, path: string): Promise<PermissionLevel> {
  relativePath(path);
  if (actor.kind === "service_account") {
    if (machineActor(actor)) await currentMachine(actor);
    else if (actor.serviceAccount.kind === "user_delegated" && actor.delegatedUser) await currentCredential(actor);
    else return "none";
  }
  const principal = principalCondition(actor);
  const grants = await sql<{ id: string }[]>`SELECT a.id FROM filesv2.storage_access s JOIN auth.access a ON a.id=s.access_id
    WHERE s.base_id=${binding.id}::uuid AND (s.path='' OR s.path=${path} OR left(${path},length(s.path)+1)=s.path || '/') AND ${principal}
    ORDER BY CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC LIMIT 1`;
  const granted = await getEffectivePermission({ accessIds: grants.map((row) => row.id), subject: filesSubject(actor) });
  const cap = filesScope(actor);
  return hasPermission(granted, cap) ? cap : granted;
}
export async function checkStorage(
  actor: RequestActor,
  binding: Binding,
  path: string,
  permission: "read" | "write" | "admin",
  requestId?: string | null,
) {
  const allowed = binding.lifecycle === "active" && hasPermission(await storagePermission(actor, binding, path), permission);
  await audit.record({
    action: `files.storage.${permission}`,
    actor: filesAuditActor(actor),
    outcome: allowed ? "allowed" : "denied",
    target: { type: "filesv2.storage", id: binding.id },
    requestId: requestId ?? requestIds.get(actor) ?? actor.delegation?.requestId,
    metadata: {
      ...principalMetadata(actor),
      pathHash: createHash("sha256").update(path).digest("hex"),
      depth: path ? path.split("/").length : 0,
    },
  });
  if (!allowed) throw new FilesError("forbidden", 403);
}
export async function machineOwner(baseId: string): Promise<MachineOwner | null> {
  const [owner] = await sql<{ owner_id: string; owner_kind: MachineOwner["kind"]; owner_name: string }[]>`
    SELECT owner_id,owner_kind,owner_name FROM filesv2.machine_storage WHERE base_id=${baseId}::uuid`;
  if (!owner) return null;
  const account = await serviceAccounts.get({ id: owner.owner_id });
  return { id: owner.owner_id, name: account?.name ?? owner.owner_name, kind: owner.owner_kind };
}
export async function listMachineStorage(after?: string): Promise<{ items: MachineStorage[]; next: string | null }> {
  const rows = await sql<
    (Binding & { provisioned: boolean })[]
  >`SELECT b.*,EXISTS(SELECT 1 FROM filesv2.operations o WHERE o.base_id=b.id AND o.action='create' AND o.state='complete') AS provisioned FROM filesv2.bases b JOIN filesv2.machine_storage m ON m.base_id=b.id
    WHERE (${after ?? null}::uuid IS NULL OR b.id>${after ?? null}::uuid) ORDER BY b.id LIMIT 51`;
  return {
    items: await Promise.all(
      rows.slice(0, 50).map(async (row) => ({
        id: row.id,
        baseId: storageBaseId(row),
        owner: (await machineOwner(row.id))!,
        area: row.area,
        state: row.lifecycle === "active" && !row.provisioned ? "provisioning" : row.lifecycle,
      })),
    ),
    next: rows.length > 50 ? rows[49]!.id : null,
  };
}
export async function storageGrants(baseId: string, after?: string, accessId?: string) {
  const rows = await sql<
    {
      id: string;
      user_id: string | null;
      group_id: string | null;
      service_account_id: string | null;
      permission: PermissionLevel;
      path: string;
      created_at: Date;
    }[]
  >`
    SELECT a.*,s.path FROM filesv2.storage_access s JOIN auth.access a ON a.id=s.access_id WHERE s.base_id=${baseId}::uuid AND (${after ?? null}::uuid IS NULL OR a.id>${after ?? null}::uuid) AND (${accessId ?? null}::uuid IS NULL OR a.id=${accessId ?? null}::uuid) ORDER BY a.id LIMIT 51`;
  const items = await resolveDisplayNames(
    rows.slice(0, 50).map((row) => ({
      id: row.id,
      principal: row.user_id
        ? { type: "user" as const, userId: row.user_id }
        : row.group_id
          ? { type: "group" as const, groupId: row.group_id }
          : { type: "service_account" as const, serviceAccountId: row.service_account_id! },
      permission: row.permission,
      path: row.path,
      createdAt: row.created_at.toISOString(),
    })),
  );
  return { items, next: rows.length > 50 ? rows[49]!.id : null };
}
export async function grantStorage(baseId: string, path: string, principal: Principal, permission: "read" | "write" | "admin") {
  relativePath(path);
  if (!(await machineStorage.owner(baseId))) throw new FilesError("not_found", 404);
  if (principal.type === "service_account") {
    const account = await serviceAccounts.get({ id: principal.serviceAccountId });
    if (!account || account.status !== "active" || !["standalone", "agent"].includes(account.kind)) throw new FilesError("forbidden", 403);
  } else if (principal.type !== "user" && principal.type !== "group") throw new FilesError("forbidden", 403);
  const id = await sql.begin(async (tx) => {
    const [storage] = await tx`SELECT base_id FROM filesv2.machine_storage WHERE base_id=${baseId}::uuid FOR UPDATE`;
    if (!storage) throw new FilesError("not_found", 404);
    const match =
      principal.type === "user"
        ? sql`a.user_id=${principal.userId}::uuid`
        : principal.type === "group"
          ? sql`a.group_id=${principal.groupId}::uuid`
          : principal.type === "service_account"
            ? sql`a.service_account_id=${principal.serviceAccountId}::uuid`
            : sql`false`;
    const [existing] = await tx<
      { id: string }[]
    >`SELECT a.id FROM filesv2.storage_access s JOIN auth.access a ON a.id=s.access_id WHERE s.base_id=${baseId}::uuid AND s.path=${path} AND ${match} FOR UPDATE OF s,a`;
    if (existing) {
      const changed = await updateAccess({ id: existing.id, permission }, tx);
      if (!changed.ok) throw new FilesError("invalid_configuration", 400);
      return existing.id;
    }
    const result = await createAccess({ principal, permission }, tx);
    if (!result.ok) throw new FilesError("invalid_configuration", 400);
    await tx`INSERT INTO filesv2.storage_access(base_id,path,access_id) VALUES(${baseId}::uuid,${path},${result.data.id}::uuid)`;
    return result.data.id;
  });
  const grant = (await storageGrants(baseId, undefined, id)).items[0];
  if (!grant) throw new FilesError("not_found", 404);
  return grant;
}
export async function revokeStorage(baseId: string, accessId: string) {
  const [grant] = await sql`SELECT access_id FROM filesv2.storage_access WHERE base_id=${baseId}::uuid AND access_id=${accessId}::uuid`;
  if (!grant) throw new FilesError("not_found", 404);
  await deleteAccess({ id: accessId });
}

export type TransferPayload = { url: string; kind: "download" | "upload" | "archive"; manifest?: string; paths?: string[] };
type Ticket = {
  base_id: string;
  principal_id: string;
  principal_kind: "user" | "service_account";
  delegated_user_id: string | null;
  credential_id: string | null;
  oauth_client_id: string | null;
  credential_expires_at: Date | null;
  scopes: string[];
  path: string;
  permission: "read" | "write";
  share_id: string | null;
  payload: string;
  expires_at: Date;
};
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export async function transferTicket(
  actor: RequestActor,
  binding: Binding,
  path: string,
  payload: TransferPayload,
  expires: string,
  shareId?: string,
) {
  await checkStorage(actor, binding, path, payload.kind === "upload" ? "write" : "read");
  const token = randomBytes(32).toString("base64url");
  await sql`DELETE FROM filesv2.transfer_tickets WHERE digest IN (SELECT digest FROM filesv2.transfer_tickets WHERE expires_at<=now() LIMIT 100)`;
  const encrypted = await secrets.encrypt(payload);
  await sql`INSERT INTO filesv2.transfer_tickets(digest,base_id,principal_id,principal_kind,delegated_user_id,credential_id,oauth_client_id,credential_expires_at,scopes,path,permission,share_id,payload,expires_at)
    VALUES(${digest(token)},${binding.id}::uuid,${actor.kind === "user" ? actor.user.id : actor.serviceAccount.id}::uuid,${actor.kind},${actor.kind === "service_account" ? (actor.delegatedUser?.id ?? null) : null}::uuid,${actor.kind === "service_account" ? (actor.credentialId ?? null) : null}::uuid,${actor.kind === "service_account" ? (actor.oauthClientId ?? null) : null},${actor.kind === "service_account" ? (actor.credentialExpiresAt ?? null) : null}::timestamptz,${toPgTextArray(actor.kind === "service_account" ? actor.scopes : [])}::text[],${path},${payload.kind === "upload" ? "write" : "read"},${shareId ?? null}::uuid,${encrypted},${expires}::timestamptz)`;
  return `/share/filesv2/transfer/${token}`;
}
export async function readTransferTicket(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new FilesError("not_found", 404);
  const [ticket] = await sql<Ticket[]>`SELECT * FROM filesv2.transfer_tickets WHERE digest=${digest(token)} AND expires_at>now()`;
  if (!ticket) throw new FilesError("transfer_expired", 410);
  let actor: RequestActor;
  if (ticket.principal_kind === "user") {
    const user = await accounts.users.get({ id: ticket.principal_id });
    if (!user || (user.accountExpires && Date.parse(user.accountExpires) <= Date.now())) throw new FilesError("forbidden", 403);
    actor = { kind: "user", user };
  } else {
    const account = await serviceAccounts.get({ id: ticket.principal_id });
    if (!account) throw new FilesError("forbidden", 403);
    const delegatedUser = ticket.delegated_user_id ? await accounts.users.get({ id: ticket.delegated_user_id }) : null;
    if (
      ticket.delegated_user_id &&
      (!delegatedUser || (delegatedUser.accountExpires && Date.parse(delegatedUser.accountExpires) <= Date.now()))
    )
      throw new FilesError("forbidden", 403);
    const machine: Extract<RequestActor, { kind: "service_account" }> = {
      kind: "service_account",
      serviceAccount: account,
      delegatedUser,
      scopes: ticket.scopes,
      credentialId: ticket.credential_id,
      oauthClientId: ticket.oauth_client_id,
      credentialExpiresAt: ticket.credential_expires_at?.toISOString() ?? null,
    };
    await currentCredential(machine);
    actor = machine;
  }
  const payload: unknown = await secrets.decrypt(ticket.payload);
  // Encrypted, application-generated values only; never accept a caller-selected upstream URL.
  const parsed = z
    .object({
      url: z.string().url(),
      kind: z.enum(["download", "upload", "archive"]),
      manifest: z.string().optional(),
      paths: z.array(z.string()).max(100).optional(),
    })
    .parse(payload);
  return { ticket, actor, payload: parsed };
}
