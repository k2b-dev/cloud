import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { Principal, RequestActor } from "@k2b/cloud/server";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { EntryResult } from "../contracts";
import { TEMPLATE_LIMIT } from "../document-assets";
import { migrate } from "../migrate";
import { filesService } from ".";
import type { UserFilesCall } from "./activity";
import { createTemplateService } from "./templates";

const suite = suiteFor("database");
const stamp = "2030-05-15T12:00:00.000Z";
const templateId = "20000000-0000-4000-8000-000000000001";
const otherTemplateId = "20000000-0000-4000-8000-000000000002";
const readerId = "10000000-0000-4000-8000-000000000002";
const groupId = "30000000-0000-4000-8000-000000000001";
const accessId = "40000000-0000-4000-8000-000000000001";
const missingId = "90000000-0000-4000-8000-000000000001";
const snapshotBytes = Buffer.from("private template snapshot");
const upload = {
  name: "Template name",
  description: "Private description",
  filename: "private-template.md",
  content: snapshotBytes.toString("base64"),
};
const source = { baseId: "cloud:users:source-owner", path: "private/source.md" };
type AuditRow = {
  action: string;
  outcome: string;
  actor_user_id: string | null;
  actor_uid: string | null;
  actor_provider: string | null;
  actor_roles: string[];
  target_type: string;
  target_id: string;
  target_label: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
};

suite("Template administration security audit", () => {
  if (testActor.kind !== "user") throw new Error("Expected user fixture");
  const actor: Extract<RequestActor, { kind: "user" }> = {
    ...testActor,
    user: { ...testActor.user, roles: ["user", "admin"] },
  };
  const reader: Extract<RequestActor, { kind: "user" }> = {
    ...testActor,
    user: { ...testActor.user, id: readerId, uid: "reader", displayName: "Reader", roles: ["user"] },
  };
  // Identity for audit must come from the actor, never the grant subject.
  const call: UserFilesCall = {
    ...testCall(actor),
    accessSubject: { type: "user", userId: readerId },
    via: "agent",
    requestId: "template-request",
    invocationId: "template-invocation",
    callingApp: "assistant",
    origin: "assistant",
  };
  const failingCall = { ...call, requestId: "template-audit-failure" };
  const readerCall = testCall(reader);
  const sourceCalls: Array<{ call: UserFilesCall; input: typeof source }> = [];
  const createCalls: Array<{ call: UserFilesCall; input: { baseId: string; path: string }; bytes: Uint8Array<ArrayBuffer> }> = [];
  let sourceFailure = false;
  const created: EntryResult = {
    base: {
      id: "target-base",
      area: "cloud",
      kind: "users",
      name: "Reader",
      status: "existing",
      reason: null,
      indexEnabled: true,
      versioningEnabled: true,
    },
    entry: { name: "copy.md", path: "copy.md", directory: false, size: snapshotBytes.length, modified: stamp },
  };
  const service = createTemplateService({
    ...filesService,
    async templateSource(call, input) {
      sourceCalls.push({ call, input });
      if (sourceFailure) throw new Error("source unavailable");
      return { filename: "source.md", bytes: new Uint8Array(snapshotBytes) };
    },
    async createFromBytes(call, input, bytes) {
      createCalls.push({ call, input, bytes });
      return created;
    },
  });
  const events = () => sql<AuditRow[]>`SELECT * FROM audit.events ORDER BY id`;
  const context = {
    via: call.via,
    calling_app: call.callingApp,
    origin: call.origin,
    invocation_id: call.invocationId,
  };
  function expectEvent(event: AuditRow | undefined, action: string, id: string, metadata: Record<string, unknown> = {}) {
    expect(event).toMatchObject({
      action: `filesv2.template.${action}`,
      outcome: "allowed",
      actor_user_id: actor.user.id,
      actor_uid: null,
      actor_provider: null,
      actor_roles: [],
      target_type: "filesv2.template",
      target_id: id,
      target_label: null,
      request_id: call.requestId,
    });
    expect(event?.metadata).toEqual({ ...context, ...metadata });
  }
  async function seedTemplate(id = templateId) {
    await sql`INSERT INTO filesv2.templates(id,name,description,filename,bytes,size,created_by,updated_at)
      VALUES(${id}::uuid,'Seed','Seed description','seed.md',${Buffer.from("seed bytes")},10,${actor.user.id}::uuid,${stamp}::timestamptz)`;
  }
  async function seedGrant(id = templateId) {
    await sql`INSERT INTO auth.access(id,user_id,permission,created_at) VALUES(${accessId}::uuid,${readerId}::uuid,'read',${stamp}::timestamptz)`;
    await sql`INSERT INTO filesv2.template_access(template_id,access_id) VALUES(${id}::uuid,${accessId}::uuid)`;
  }
  async function state() {
    return {
      templates: await sql<Record<string, unknown>[]>`SELECT * FROM filesv2.templates ORDER BY id`,
      access: await sql<Record<string, unknown>[]>`SELECT * FROM auth.access ORDER BY id`,
      links: await sql<Record<string, unknown>[]>`SELECT * FROM filesv2.template_access ORDER BY template_id,access_id`,
      audit: await events(),
      activity: await sql<Record<string, unknown>[]>`SELECT * FROM filesv2.activity ORDER BY id`,
    };
  }
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin')`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,provider text,profile text,admin boolean,
      account_expires timestamptz,display_name text,avatar_hash text)`.simple();
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text,gid_number integer)`.simple();
    await sql`CREATE TABLE auth.user_posix(user_id uuid PRIMARY KEY REFERENCES auth.users(id),managed_by text,
      uid_number integer,primary_gid_number integer,primary_group_id uuid)`.simple();
    await sql`CREATE TABLE auth.user_groups_v2(user_id uuid REFERENCES auth.users(id),group_id uuid REFERENCES auth.groups(id))`.simple();
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id uuid REFERENCES auth.groups(id),child_group_id uuid REFERENCES auth.groups(id))`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users(id),
      group_id uuid REFERENCES auth.groups(id),service_account_id uuid,authenticated_only boolean NOT NULL DEFAULT false,
      permission auth.permission_level NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.simple();
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text)`.simple();
    await migrate();
    await migrateAudit();
    // A real database failure proves that audit and domain writes share one transaction.
    await sql`CREATE FUNCTION audit.reject_template_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'template-audit-failure' THEN RAISE EXCEPTION 'template audit unavailable'; END IF;
        RETURN NEW;
      END; $$`.simple();
    await sql`CREATE TRIGGER reject_template_test_event BEFORE INSERT ON audit.events
      FOR EACH ROW EXECUTE FUNCTION audit.reject_template_test_event()`.simple();
  });
  beforeEach(async () => {
    await sql`TRUNCATE filesv2.templates,auth.access,auth.users,auth.groups,audit.events,filesv2.activity CASCADE`.simple();
    for (const current of [actor, reader]) {
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name)
        VALUES(${current.user.id}::uuid,${current.user.uid},'local','user',${current === actor},${current.user.displayName})`;
    }
    await sql`INSERT INTO auth.groups(id,name,provider) VALUES(${groupId}::uuid,'Template readers','local')`;
    sourceCalls.length = 0;
    createCalls.length = 0;
    sourceFailure = false;
  });

  test("upload records only identity, target and call provenance, without template content", async () => {
    const result = await service.upload(call, upload);
    expect(result).toMatchObject({
      name: upload.name,
      description: upload.description,
      filename: upload.filename,
      size: snapshotBytes.length,
    });
    const [stored] = await sql<
      { bytes: Uint8Array; created_by: string }[]
    >`SELECT bytes,created_by FROM filesv2.templates WHERE id=${result.id}::uuid`;
    expect(Buffer.from(stored!.bytes)).toEqual(snapshotBytes);
    expect(stored?.created_by).toBe(actor.user.id);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "upload", result.id);
    expect((await state()).activity).toHaveLength(0);
  });

  test("import retains the source call and records a distinct atomic import event", async () => {
    const result = await service.import(call, { name: upload.name, description: upload.description, source });
    expect(sourceCalls).toHaveLength(1);
    expect(sourceCalls[0]?.call).toBe(call);
    expect(sourceCalls[0]?.input).toBe(source);
    expect(result.filename).toBe("source.md");
    const [stored] = await sql<{ bytes: Uint8Array }[]>`SELECT bytes FROM filesv2.templates WHERE id=${result.id}::uuid`;
    expect(Buffer.from(stored!.bytes)).toEqual(snapshotBytes);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "import", result.id);
    expect((await state()).activity).toHaveLength(0);
  });

  test("an import source failure does not create a template or an audit event", async () => {
    sourceFailure = true;
    const before = await state();
    await expect(service.import(call, { name: "Import", description: "", source })).rejects.toThrow("source unavailable");
    expect(await state()).toEqual(before);
  });

  const updates = [
    {
      name: "metadata update",
      action: "update",
      run: (requestCall: UserFilesCall, id: string) =>
        service.update(requestCall, id, { name: "Updated", description: "Updated description" }),
      filename: "seed.md",
      bytes: Buffer.from("seed bytes"),
      templateName: "Updated",
    },
    {
      name: "metadata and snapshot update",
      action: "update",
      run: (requestCall: UserFilesCall, id: string) =>
        service.update(requestCall, id, { name: "Updated", description: "Updated description", file: upload }),
      filename: upload.filename,
      bytes: snapshotBytes,
      templateName: "Updated",
    },
    {
      name: "snapshot replacement",
      action: "replace",
      run: (requestCall: UserFilesCall, id: string) => service.replace(requestCall, id, upload),
      filename: upload.filename,
      bytes: snapshotBytes,
      templateName: "Seed",
    },
  ];
  for (const mutation of updates) {
    test(`${mutation.name} commits with exactly one security event`, async () => {
      await seedTemplate();
      const result = await mutation.run(call, templateId);
      expect(result).toMatchObject({ name: mutation.templateName, filename: mutation.filename, size: mutation.bytes.length });
      const [stored] = await sql<{ bytes: Uint8Array }[]>`SELECT bytes FROM filesv2.templates WHERE id=${templateId}::uuid`;
      expect(Buffer.from(stored!.bytes)).toEqual(mutation.bytes);
      const rows = await events();
      expect(rows).toHaveLength(1);
      expectEvent(rows[0], mutation.action, templateId);
      expect((await state()).activity).toHaveLength(0);
    });
    test(`${mutation.name} preserves not_found without an audit success`, async () => {
      await expect(mutation.run(call, missingId)).rejects.toMatchObject({ code: "not_found", status: 404 });
      expect(await events()).toHaveLength(0);
    });
  }

  const principals: Principal[] = [{ type: "user", userId: readerId }, { type: "group", groupId }, { type: "authenticated" }];
  for (const principal of principals) {
    test(`grant and revoke preserve ${principal.type} read permissions and audit bounded principal metadata`, async () => {
      await seedTemplate();
      // Extra input fields must never leak into audit metadata.
      const supplied = { ...principal, displayName: "Private name", credential: "never-store-this" };
      const entry = await service.grant(call, templateId, supplied);
      expect(entry).toMatchObject({ principal, permission: "read" });
      expect(await service.grants(call, templateId)).toEqual([entry]);
      const principalId = principal.type === "user" ? principal.userId : principal.type === "group" ? principal.groupId : null;
      const metadata = { access_id: entry.id, principal_type: principal.type, principal_id: principalId, permission: "read" };
      expectEvent((await events())[0], "grant", templateId, metadata);
      expect(await service.revoke(call, templateId, entry.id)).toEqual({ deleted: true });
      const rows = await events();
      expect(rows).toHaveLength(2);
      expectEvent(rows[1], "revoke", templateId, metadata);
      const remaining = await state();
      expect(remaining.access).toHaveLength(0);
      expect(remaining.links).toHaveLength(0);
      expect(remaining.activity).toHaveLength(0);
    });
  }

  test("remove deletes the template and its platform grants but preserves unrelated grants", async () => {
    await seedTemplate();
    await seedTemplate(otherTemplateId);
    await seedGrant();
    const other = await service.grant(call, otherTemplateId, { type: "authenticated" });
    expect(await service.remove(call, templateId)).toEqual({ deleted: true });
    const remaining = await state();
    expect(remaining.templates.map((row) => row.id)).toEqual([otherTemplateId]);
    expect(remaining.access.map((row) => row.id)).toEqual([other.id]);
    expect(remaining.links).toHaveLength(1);
    expect(remaining.audit).toHaveLength(2);
    expectEvent(remaining.audit[1], "remove", templateId);
    expect(remaining.activity).toHaveLength(0);
    expect(await service.remove(call, templateId)).toEqual({ deleted: true });
    expect(await events()).toHaveLength(2);
  });

  const mutations = [
    { name: "upload", run: (requestCall: UserFilesCall) => service.upload(requestCall, upload) },
    { name: "import", run: (requestCall: UserFilesCall) => service.import(requestCall, { name: "Import", description: "", source }) },
    ...updates.map((mutation) => ({ name: mutation.name, run: (requestCall: UserFilesCall) => mutation.run(requestCall, templateId) })),
    { name: "remove", run: (requestCall: UserFilesCall) => service.remove(requestCall, templateId) },
    { name: "grant", run: (requestCall: UserFilesCall) => service.grant(requestCall, templateId, { type: "authenticated" }) },
    { name: "revoke", run: (requestCall: UserFilesCall) => service.revoke(requestCall, templateId, accessId) },
  ];
  for (const mutation of mutations) {
    test(`${mutation.name} rolls back every data mutation when the database rejects the audit event`, async () => {
      await seedTemplate();
      await seedGrant();
      const before = await state();
      await expect(mutation.run(failingCall)).rejects.toThrow("template audit unavailable");
      expect(await state()).toEqual(before);
    });
    test(`${mutation.name} still requires administration rights`, async () => {
      await seedTemplate();
      await seedGrant();
      const before = await state();
      await expect(mutation.run(readerCall)).rejects.toMatchObject({ code: "admin_required", status: 403 });
      expect(await state()).toEqual(before);
      expect(sourceCalls).toHaveLength(0);
    });
  }

  test("a failed junction insert rolls back the new platform grant without compensation", async () => {
    await seedTemplate();
    await sql`ALTER TABLE filesv2.template_access ADD CONSTRAINT reject_template_grant CHECK (false)`.simple();
    try {
      const before = await state();
      await expect(service.grant(call, templateId, { type: "authenticated" })).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      await sql`ALTER TABLE filesv2.template_access DROP CONSTRAINT reject_template_grant`.simple();
    }
  });

  test("unsupported and missing principals, missing templates and unrelated revokes do not mutate data", async () => {
    await seedTemplate();
    await seedTemplate(otherTemplateId);
    await seedGrant(otherTemplateId);
    const before = await state();
    for (const principal of [{ type: "public" }, { type: "service_account", serviceAccountId: missingId }] satisfies Principal[]) {
      await expect(service.grant(call, templateId, principal)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    }
    for (const principal of [
      { type: "user", userId: missingId },
      { type: "group", groupId: missingId },
    ] satisfies Principal[]) {
      await expect(service.grant(call, templateId, principal)).rejects.toMatchObject({ code: "invalid_configuration", status: 400 });
    }
    await expect(service.grant(call, missingId, { type: "authenticated" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(service.revoke(call, templateId, accessId)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(service.revoke(call, missingId, accessId)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(await state()).toEqual(before);
  });

  test("oversized snapshots still fail before any mutation or audit", async () => {
    await seedTemplate();
    const oversized = { filename: "large.md", content: Buffer.alloc(TEMPLATE_LIMIT + 1).toString("base64") };
    const before = await state();
    for (const run of [
      () => service.upload(call, { ...upload, ...oversized }),
      () => service.update(call, templateId, { name: "Large", description: "", file: oversized }),
      () => service.replace(call, templateId, oversized),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "preview_too_large", status: 400 });
    }
    expect(await state()).toEqual(before);
  });

  test("list, get, grants and use keep their permission checks and do not emit administration events", async () => {
    await seedTemplate();
    expect((await service.list(readerCall, { q: "Seed" })).items).toHaveLength(0);
    await expect(service.get(readerCall, templateId)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(service.grants(readerCall, templateId)).rejects.toMatchObject({ code: "admin_required", status: 403 });
    const target = { baseId: "target-base", path: "copy.md" };
    await expect(service.use(readerCall, templateId, target)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(createCalls).toHaveLength(0);
    await seedGrant();
    const before = await state();
    expect((await service.list(readerCall, { q: "Seed" })).items.map((row) => row.id)).toEqual([templateId]);
    expect((await service.list(call, { q: "Seed" }, true)).items.map((row) => row.id)).toEqual([templateId]);
    expect(await service.get(readerCall, templateId)).toMatchObject({ name: "Seed" });
    expect(await service.get(call, templateId, true)).toMatchObject({ name: "Seed" });
    expect(await service.grants(call, templateId)).toHaveLength(1);
    expect(await service.use(readerCall, templateId, target)).toBe(created);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.call).toBe(readerCall);
    expect(createCalls[0]?.input).toBe(target);
    expect(Buffer.from(createCalls[0]!.bytes)).toEqual(Buffer.from("seed bytes"));
    expect(await state()).toEqual(before);
  });

  test("a user-delegated service account records the delegated person and original call request", async () => {
    const delegatedActor: RequestActor = {
      kind: "service_account",
      delegatedUser: actor.user,
      scopes: ["admin"],
      credentialId: "do-not-store-credential-id",
      serviceAccount: {
        id: missingId,
        name: "Private account name",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: actor.user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: actor.user.id,
        createdAt: stamp,
      },
    };
    const result = await service.upload({ ...call, actor: delegatedActor }, upload);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expectEvent(rows[0], "upload", result.id);
  });
});
