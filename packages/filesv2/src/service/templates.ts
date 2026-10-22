import {
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getAccess,
  getEffectivePermission,
  hasPermission,
  type PermissionLevel,
  type Principal,
  type RequestActor,
  type ResourceAccessAdapter,
  resolveDisplayNames,
} from "@k2b/cloud/server";
import { accountIdentities, audit } from "@k2b/cloud/services";
import { sql, type TransactionSQL } from "bun";
import { TEMPLATE_LIMIT } from "../document-assets";
import type { FileTemplate, TemplatePage } from "../template-contracts";
import { FilesError, filesService } from ".";
import type { UserFilesCall } from "./activity";

type Row = { id: string; name: string; description: string; filename: string; size: number; updated_at: Date };
const view = (row: Row): FileTemplate => ({
  id: row.id,
  name: row.name,
  description: row.description,
  filename: row.filename,
  size: row.size,
  updatedAt: row.updated_at.toISOString(),
});
const fields = sql`id,name,description,filename,size,updated_at`;
async function user(actor: RequestActor) {
  const self = await accountIdentities.self(actor);
  if (self.user.profile !== "user") throw new FilesError("forbidden", 403);
  return self;
}
async function admin(actor: RequestActor) {
  await accountIdentities.inventory(actor, { kind: "groups", provider: "local" });
  return user(actor);
}
const access: Pick<ResourceAccessAdapter, "list"> = {
  async list(id) {
    const rows = await sql<
      { id: string; user_id: string | null; group_id: string | null; authenticated_only: boolean; created_at: Date }[]
    >`SELECT a.id,a.user_id,a.group_id,a.authenticated_only,a.created_at FROM auth.access a JOIN filesv2.template_access ta ON ta.access_id=a.id WHERE ta.template_id=${id}::uuid`;
    return resolveDisplayNames(
      rows.map((row) => ({
        id: row.id,
        principal: row.user_id
          ? { type: "user" as const, userId: row.user_id }
          : row.group_id
            ? { type: "group" as const, groupId: row.group_id }
            : { type: "authenticated" as const },
        permission: "read" as const,
        createdAt: row.created_at.toISOString(),
      })),
    );
  },
};
async function requireUse(actor: RequestActor, subject: AccessSubject, id: string) {
  await user(actor);
  const rows = await sql<{ id: string }[]>`SELECT access_id AS id FROM filesv2.template_access WHERE template_id=${id}::uuid`;
  const permission = await getEffectivePermission({ accessIds: rows.map((row) => row.id), subject });
  if (!hasPermission(permission, "read")) throw new FilesError("forbidden", 403);
}
async function get(id: string) {
  const [row] = await sql<Row[]>`SELECT ${fields} FROM filesv2.templates WHERE id=${id}::uuid`;
  if (!row) throw new FilesError("not_found", 404);
  return view(row);
}
function bytes(content: string) {
  const data = Buffer.from(content, "base64");
  if (data.byteLength > TEMPLATE_LIMIT) throw new FilesError("preview_too_large", 400);
  return data;
}
async function recordAudit(
  tx: TransactionSQL,
  call: UserFilesCall,
  action: "upload" | "import" | "update" | "replace" | "remove" | "grant" | "revoke",
  id: string,
  metadata: Record<string, unknown> = {},
) {
  const actor = call.actor.kind === "user" ? call.actor.user : call.actor.delegatedUser;
  await audit.record(
    {
      action: `filesv2.template.${action}`,
      outcome: "allowed",
      actor: { userId: actor?.id },
      target: { type: "filesv2.template", id },
      requestId: call.requestId,
      metadata: {
        via: call.via,
        calling_app: call.callingApp,
        origin: call.origin,
        invocation_id: call.invocationId,
        ...metadata,
      },
    },
    tx,
  );
}
async function createTemplate(
  call: UserFilesCall,
  input: { name: string; description: string; filename: string; content: string },
  action: "upload" | "import",
) {
  const actor = call.actor;
  const self = await admin(actor);
  const data = bytes(input.content);
  return sql.begin(async (tx) => {
    const [row] = await tx<
      Row[]
    >`INSERT INTO filesv2.templates(name,description,filename,bytes,size,created_by) VALUES(${input.name},${input.description},${input.filename},${data},${data.length},${self.user.id}::uuid) RETURNING ${fields}`;
    await recordAudit(tx, call, action, row!.id);
    return view(row!);
  });
}
function grantMetadata(accessId: string, principal: Principal, permission: PermissionLevel) {
  return {
    access_id: accessId,
    principal_type: principal.type,
    principal_id:
      principal.type === "user"
        ? principal.userId
        : principal.type === "group"
          ? principal.groupId
          : principal.type === "service_account"
            ? principal.serviceAccountId
            : null,
    permission,
  };
}
export function createTemplateService(files = filesService) {
  return {
    async list(call: UserFilesCall, input: { q: string; after?: string }, administrative = false): Promise<TemplatePage> {
      const actor = call.actor;
      const subject = call.accessSubject;
      if (administrative) await admin(actor);
      else await user(actor);
      const principal = buildAccessPrincipalCondition({
        subject,
        columns: {
          userId: sql`a.user_id`,
          groupId: sql`a.group_id`,
          serviceAccountId: sql`a.service_account_id`,
          authenticatedOnly: sql`a.authenticated_only`,
        },
      });
      const rows = await sql<
        Row[]
      >`SELECT ${fields} FROM filesv2.templates t WHERE (${input.after ?? null}::uuid IS NULL OR t.id > ${input.after ?? null}::uuid)
      AND position(lower(${input.q}) in lower(t.name)) > 0
      AND (${administrative} OR EXISTS(SELECT 1 FROM filesv2.template_access ta JOIN auth.access a ON a.id=ta.access_id WHERE ta.template_id=t.id AND ${principal} AND a.permission IN ('read','write','admin')))
      ORDER BY t.id LIMIT 51`;
      return { items: rows.slice(0, 50).map(view), next: rows.length > 50 ? rows[49]!.id : null };
    },
    async get(call: UserFilesCall, id: string, administrative = false) {
      const actor = call.actor;
      const subject = call.accessSubject;
      if (administrative) await admin(actor);
      else await requireUse(actor, subject, id);
      return get(id);
    },
    async upload(call: UserFilesCall, input: { name: string; description: string; filename: string; content: string }) {
      return createTemplate(call, input, "upload");
    },
    async import(call: UserFilesCall, input: { name: string; description: string; source: { baseId: string; path: string } }) {
      const actor = call.actor;
      await admin(actor);
      const source = await files.templateSource(call, input.source);
      return createTemplate(call, { ...input, filename: source.filename, content: Buffer.from(source.bytes).toString("base64") }, "import");
    },
    async update(
      call: UserFilesCall,
      id: string,
      input: { name: string; description: string; file?: { filename: string; content: string } },
    ) {
      const actor = call.actor;
      await admin(actor);
      const data = input.file ? bytes(input.file.content) : null;
      return sql.begin(async (tx) => {
        const [row] = await tx<
          Row[]
        >`UPDATE filesv2.templates SET name=${input.name},description=${input.description},filename=COALESCE(${input.file?.filename ?? null},filename),bytes=COALESCE(${data},bytes),size=COALESCE(${data?.length ?? null},size),updated_at=now() WHERE id=${id}::uuid RETURNING ${fields}`;
        if (!row) throw new FilesError("not_found", 404);
        await recordAudit(tx, call, "update", id);
        return view(row);
      });
    },
    async replace(call: UserFilesCall, id: string, input: { filename: string; content: string }) {
      const actor = call.actor;
      await admin(actor);
      const data = bytes(input.content);
      return sql.begin(async (tx) => {
        const [row] = await tx<
          Row[]
        >`UPDATE filesv2.templates SET filename=${input.filename},bytes=${data},size=${data.length},updated_at=now() WHERE id=${id}::uuid RETURNING ${fields}`;
        if (!row) throw new FilesError("not_found", 404);
        await recordAudit(tx, call, "replace", id);
        return view(row);
      });
    },
    async remove(call: UserFilesCall, id: string) {
      const actor = call.actor;
      await admin(actor);
      await sql.begin(async (tx) => {
        const [template] = await tx<{ id: string }[]>`SELECT id FROM filesv2.templates WHERE id=${id}::uuid FOR UPDATE`;
        if (!template) return;
        await tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM filesv2.template_access WHERE template_id=${id}::uuid)`;
        const [row] = await tx<{ id: string }[]>`DELETE FROM filesv2.templates WHERE id=${id}::uuid RETURNING id`;
        if (row) await recordAudit(tx, call, "remove", id);
      });
      return { deleted: true };
    },
    async grants(call: UserFilesCall, id: string) {
      const actor = call.actor;
      await admin(actor);
      await get(id);
      return access.list(id);
    },
    async grant(call: UserFilesCall, id: string, principal: Principal) {
      const actor = call.actor;
      await admin(actor);
      await get(id);
      if (!["user", "group", "authenticated"].includes(principal.type)) throw new FilesError("forbidden", 403);
      const accessId = await sql.begin(async (tx) => {
        const [template] = await tx<{ id: string }[]>`SELECT id FROM filesv2.templates WHERE id=${id}::uuid FOR UPDATE`;
        if (!template) throw new FilesError("not_found", 404);
        const result = await createAccess({ principal, permission: "read" }, tx);
        if (!result.ok) throw new FilesError("invalid_configuration", 400);
        await tx`INSERT INTO filesv2.template_access(template_id,access_id) VALUES(${id}::uuid,${result.data.id}::uuid)`;
        await recordAudit(tx, call, "grant", id, grantMetadata(result.data.id, principal, "read"));
        return result.data.id;
      });
      return (await access.list(id)).find((entry) => entry.id === accessId)!;
    },
    async revoke(call: UserFilesCall, id: string, accessId: string) {
      const actor = call.actor;
      await admin(actor);
      await sql.begin(async (tx) => {
        const [template] = await tx<{ id: string }[]>`SELECT id FROM filesv2.templates WHERE id=${id}::uuid FOR UPDATE`;
        if (!template) throw new FilesError("not_found", 404);
        const [row] = await tx<
          { access_id: string }[]
        >`SELECT access_id FROM filesv2.template_access WHERE template_id=${id}::uuid AND access_id=${accessId}::uuid`;
        if (!row) throw new FilesError("not_found", 404);
        const entry = await getAccess({ id: accessId }, tx);
        if (!entry) throw new FilesError("not_found", 404);
        const result = await deleteAccess({ id: accessId }, tx);
        if (!result.ok) throw new FilesError("not_found", 404);
        await recordAudit(tx, call, "revoke", id, grantMetadata(accessId, entry.principal, entry.permission));
      });
      return { deleted: true };
    },
    async use(call: UserFilesCall, id: string, input: { baseId: string; path: string }) {
      const actor = call.actor;
      const subject = call.accessSubject;
      await requireUse(actor, subject, id);
      const [row] = await sql<{ bytes: Uint8Array<ArrayBuffer> }[]>`SELECT bytes FROM filesv2.templates WHERE id=${id}::uuid`;
      if (!row) throw new FilesError("not_found", 404);
      return files.createFromBytes(call, { ...input, templateId: id }, new Uint8Array(row.bytes));
    },
  };
}
export const templateService = createTemplateService();
