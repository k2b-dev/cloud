import {
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getEffectivePermission,
  hasPermission,
  type Principal,
  type RequestActor,
  type ResourceAccessAdapter,
  resolveDisplayNames,
} from "@k2b/cloud/server";
import { accountIdentities } from "@k2b/cloud/services";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { TEMPLATE_LIMIT } from "../document-assets";
import type { FileTemplate, TemplatePage } from "../template-contracts";
import { FilesError, filesService } from ".";

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
const access: ResourceAccessAdapter = {
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
  async add(id, accessId) {
    await sql`INSERT INTO filesv2.template_access(template_id,access_id) VALUES(${id}::uuid,${accessId}::uuid)`;
    return ok(undefined);
  },
  async remove(id, accessId) {
    await sql`DELETE FROM filesv2.template_access WHERE template_id=${id}::uuid AND access_id=${accessId}::uuid`;
    return ok(undefined);
  },
  async count(id) {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM filesv2.template_access WHERE template_id=${id}::uuid`;
    return row!.count;
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
export function createTemplateService(files = filesService) {
  return {
    async list(
      actor: RequestActor,
      subject: AccessSubject,
      input: { q: string; after?: string },
      administrative = false,
    ): Promise<TemplatePage> {
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
    async get(actor: RequestActor, subject: AccessSubject, id: string, administrative = false) {
      if (administrative) await admin(actor);
      else await requireUse(actor, subject, id);
      return get(id);
    },
    async upload(actor: RequestActor, input: { name: string; description: string; filename: string; content: string }) {
      const self = await admin(actor);
      const data = bytes(input.content);
      const [row] = await sql<
        Row[]
      >`INSERT INTO filesv2.templates(name,description,filename,bytes,size,created_by) VALUES(${input.name},${input.description},${input.filename},${data},${data.length},${self.user.id}::uuid) RETURNING ${fields}`;
      return view(row!);
    },
    async import(actor: RequestActor, input: { name: string; description: string; source: { baseId: string; path: string } }) {
      await admin(actor);
      const source = await files.templateSource(actor, input.source);
      return this.upload(actor, { ...input, filename: source.filename, content: Buffer.from(source.bytes).toString("base64") });
    },
    async update(
      actor: RequestActor,
      id: string,
      input: { name: string; description: string; file?: { filename: string; content: string } },
    ) {
      await admin(actor);
      const data = input.file ? bytes(input.file.content) : null;
      const [row] = await sql<
        Row[]
      >`UPDATE filesv2.templates SET name=${input.name},description=${input.description},filename=COALESCE(${input.file?.filename ?? null},filename),bytes=COALESCE(${data},bytes),size=COALESCE(${data?.length ?? null},size),updated_at=now() WHERE id=${id}::uuid RETURNING ${fields}`;
      if (!row) throw new FilesError("not_found", 404);
      return view(row);
    },
    async replace(actor: RequestActor, id: string, input: { filename: string; content: string }) {
      await admin(actor);
      const data = bytes(input.content);
      const [row] = await sql<
        Row[]
      >`UPDATE filesv2.templates SET filename=${input.filename},bytes=${data},size=${data.length},updated_at=now() WHERE id=${id}::uuid RETURNING ${fields}`;
      if (!row) throw new FilesError("not_found", 404);
      return view(row);
    },
    async remove(actor: RequestActor, id: string) {
      await admin(actor);
      await sql.begin(async (tx) => {
        await tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM filesv2.template_access WHERE template_id=${id}::uuid)`;
        await tx`DELETE FROM filesv2.templates WHERE id=${id}::uuid`;
      });
      return { deleted: true };
    },
    async grants(actor: RequestActor, id: string) {
      await admin(actor);
      await get(id);
      return access.list(id);
    },
    async grant(actor: RequestActor, id: string, principal: Principal) {
      await admin(actor);
      await get(id);
      if (!["user", "group", "authenticated"].includes(principal.type)) throw new FilesError("forbidden", 403);
      const result = await createAccess({ principal, permission: "read" });
      if (!result.ok) throw new FilesError("invalid_configuration", 400);
      try {
        await access.add(id, result.data.id);
      } catch (error) {
        await deleteAccess({ id: result.data.id });
        throw error;
      }
      return (await access.list(id)).find((entry) => entry.id === result.data.id)!;
    },
    async revoke(actor: RequestActor, id: string, accessId: string) {
      await admin(actor);
      const [row] = await sql`SELECT access_id FROM filesv2.template_access WHERE template_id=${id}::uuid AND access_id=${accessId}::uuid`;
      if (!row) throw new FilesError("not_found", 404);
      await deleteAccess({ id: accessId });
      return { deleted: true };
    },
    async use(actor: RequestActor, subject: AccessSubject, id: string, input: { baseId: string; path: string }) {
      await requireUse(actor, subject, id);
      const [row] = await sql<{ bytes: Uint8Array<ArrayBuffer> }[]>`SELECT bytes FROM filesv2.templates WHERE id=${id}::uuid`;
      if (!row) throw new FilesError("not_found", 404);
      return files.createFromBytes(actor, input, new Uint8Array(row.bytes));
    },
  };
}
export const templateService = createTemplateService();
