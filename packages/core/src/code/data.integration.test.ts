import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiCapabilities } from "../capabilities";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import * as access from "./access";
import { type Code, codeQueryContracts } from "./contracts";
import { CODE_SETTINGS, codeSettings } from "./settings";
import {
  addCodeAccess,
  appendCodeCall,
  codeBundleHash,
  codeSourceHash,
  createCode,
  createCodeVersion,
  expireCodeRuns,
  finishCodeCall,
  insertCodeRun,
  readCode,
  readCodeVersion,
  removeCodeAccess,
} from "./store";

const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  editor: "22222222-2222-4222-8222-222222222222",
  reader: "33333333-3333-4333-8333-333333333333",
  stranger: "44444444-4444-4444-8444-444444444444",
  admin: "55555555-5555-4555-8555-555555555555",
  creator: "66666666-6666-4666-8666-666666666666",
};
const fixed = new Date("2026-10-31T12:00:00.000Z");
const person = (id: string, admin = false): User => ({
  id,
  uid: id,
  roles: admin ? ["admin"] : ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Test",
  displayName: "Code Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const authority = (id: string, admin = false): RequestAuthority => ({
  actor: { kind: "user", user: person(id, admin) },
  accessSubject: { type: "user", userId: id },
  credentialKind: "session",
  scopes: [],
});
const context = (id: string, admin = false): CapabilityExecutionContext => ({
  authority: authority(id, admin),
  actor: authority(id, admin).actor,
  accessSubject: { type: "user", userId: id },
  user: person(id, admin),
  locale: "en",
  requestId: "code-test",
  origin: "http",
  signal: new AbortController().signal,
});
const ctx = (id: string, admin = false): access.CodeContext => ({ authority: authority(id, admin), locale: "en" });

// Each database is private to this suite; integration runs only with explicit CLOUD_TEST_DATABASE_URL in CI.
databaseSuite()("Core Code data and Query authorization", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let code: Code;
  let versionId: string;
  let runId: string;
  let settingsSpy: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  const ownerState = new Map<string, { title: string; admin: boolean }>();
  let ownerSpy: ReturnType<typeof spyOn<typeof access, "readCodeOwner">>;
  beforeAll(async () => {
    database = await useFreshDatabase("core_code");
    await migrateAuth();
    for (const [name, id] of Object.entries(ids))
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${name},'local','user',${name === "admin"})`;
    // Forward migration over an already populated identity database.
    await migrateCode();
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    ownerSpy = spyOn(access, "readCodeOwner").mockImplementation(async (owner, context) => {
      if (owner.kind === "person")
        return owner.userId === (context.authority.accessSubject.type === "user" ? context.authority.accessSubject.userId : null)
          ? { title: "Person", admin: true }
          : null;
      const user = context.authority.accessSubject.type === "user" ? context.authority.accessSubject.userId : "";
      return ownerState.get(user) ?? { title: "Mailbox today", admin: false };
    });
    code = await createCode({ owner: { kind: "person", userId: ids.owner }, title: "Monday report" }, ctx(ids.owner));
    const version = await createCodeVersion(
      {
        codeId: code.id,
        sourceFiles: { "code.ts": "export default 'source';" },
        bundle: "export default 'bundle';",
        manifest: { phase: 1 },
        baseVersionId: null,
      },
      ctx(ids.owner),
    );
    versionId = version.id;
    await addCodeAccess(code.id, { type: "user", userId: ids.editor }, "editor", ctx(ids.owner));
    await addCodeAccess(code.id, { type: "user", userId: ids.reader }, "reader", ctx(ids.owner));
    runId = await insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "weekly", input: { private: "run input" } });
    await sql`UPDATE code.runs SET state='running',started_at=${fixed} WHERE id=${runId}::uuid`;
    await sql.begin(async (tx) => {
      const first = await appendCodeCall(
        { runId, kind: "query", call: { capability: "example.item.read", target: null, refs: {}, input: { private: "call input" } } },
        tx,
      );
      await finishCodeCall({ runId, ordinal: first, state: "succeeded", result: { private: "call result" }, endedAt: fixed }, tx);
      const second = await appendCodeCall(
        {
          runId,
          kind: "action",
          call: { capability: "example.item.update", target: { type: "example.item", id: "item" }, refs: {}, input: {} },
        },
        tx,
      );
      await finishCodeCall({ runId, ordinal: second, state: "failed", result: { error: "refused" }, endedAt: fixed }, tx);
    });
  });
  afterAll(async () => {
    ownerSpy?.mockRestore();
    settingsSpy?.mockRestore();
    await database?.drop();
  });

  test("forward migration is idempotent on a filled DB and preserves pre-existing accounts", async () => {
    const before = await sql`SELECT * FROM code.codes ORDER BY id`;
    await migrateCode();
    await migrateCode();
    expect(await sql`SELECT * FROM code.codes ORDER BY id`).toEqual(before);
    expect(await sql`SELECT id FROM auth.users`).toHaveLength(6);
    expect(await sql`SELECT * FROM code.versions WHERE id=${versionId}::uuid`).toHaveLength(1);
  });
  test("all five Query contracts enforce editor, reader, unrelated and Cloud-admin visibility", async () => {
    for (const [id, admin, allowed] of [
      [ids.owner, false, true],
      [ids.editor, false, true],
      [ids.reader, false, true],
      [ids.stranger, false, false],
      [ids.admin, true, true],
    ] as const) {
      const c = context(id, admin);
      const list = await aiCapabilities.queries["code.list"].run({ limit: 20 }, c);
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.data.data.items.some((item) => item.id === code.id)).toBe(allowed);
      const read = await aiCapabilities.queries["code.read"].run({ codeId: code.id }, c);
      const version = await aiCapabilities.queries["code.version.read"].run(
        { codeId: code.id, versionId, offset: 0, length: 100, content: { kind: "source", path: "code.ts" } },
        c,
      );
      const runs = await aiCapabilities.queries["code.run.list"].run({ codeId: code.id, limit: 20 }, c);
      const run = await aiCapabilities.queries["code.run.read"].run({ codeId: code.id, runId, cursor: 0 }, c);
      for (const response of [read, version, runs, run]) expect(response.ok).toBe(allowed);
      if (run.ok) {
        expect(codeQueryContracts.runRead.data.safeParse(run.data.data).success).toBe(true);
        if (id === ids.reader) {
          expect(run.data.data.contents).toBeNull();
          expect(JSON.stringify(run)).not.toContain("private");
        } else {
          expect(run.data.data.contents?.input).toEqual({ private: "run input" });
          expect(run.data.data.contents?.calls[0]?.ordinal).toBe(1);
          expect(run.data.data.contents?.nextCursor).toBe(1);
        }
      }
      if (runs.ok) expect(JSON.stringify(runs)).not.toContain("private");
      if (version.ok) expect(version.data.data.content?.text).toBe("export default 'source';");
    }
    const second = await aiCapabilities.queries["code.run.read"].run({ codeId: code.id, runId, cursor: 1 }, context(ids.owner));
    expect(second.ok && second.data.data.contents?.calls[0]?.ordinal).toBe(2);
  });
  test("a Code account itself sees none of the five Queries, even with an accidental direct grant", async () => {
    const resource = await createCode(
      { owner: { kind: "resource", ref: { type: "example.mailbox", id: "own-account" } }, title: "Resource" },
      ctx(ids.admin, true),
    );
    const [account] = await sql<
      { id: string; name: string; created_at: Date }[]
    >`SELECT id,name,created_at FROM auth.service_accounts WHERE id=${resource.serviceAccountId}::uuid`;
    if (!account) throw new Error("Missing account");
    const actor: RequestAuthority["actor"] = {
      kind: "service_account",
      serviceAccount: {
        id: account.id,
        name: account.name,
        kind: "code",
        status: "active",
        delegatedUserId: null,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: ids.admin,
        createdAt: account.created_at.toISOString(),
      },
      delegatedUser: null,
      scopes: [],
      credentialId: "test",
      credentialExpiresAt: null,
    };
    const codeContext: CapabilityExecutionContext = {
      ...context(ids.owner),
      authority: {
        actor,
        accessSubject: { type: "service_account", serviceAccountId: account.id },
        credentialKind: "invocation",
        scopes: [],
      },
      actor,
      accessSubject: { type: "service_account", serviceAccountId: account.id },
      user: null,
    };
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${account.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO code.access(code_id,access_id) VALUES(${code.id},${grant!.id}::uuid)`;
    expect((await aiCapabilities.queries["code.list"].run({ limit: 20 }, codeContext)).ok).toBe(false);
    expect((await aiCapabilities.queries["code.read"].run({ codeId: code.id }, codeContext)).ok).toBe(false);
    expect(
      (await aiCapabilities.queries["code.version.read"].run({ codeId: code.id, versionId, offset: 0, length: 100 }, codeContext)).ok,
    ).toBe(false);
    expect((await aiCapabilities.queries["code.run.list"].run({ codeId: code.id, limit: 20 }, codeContext)).ok).toBe(false);
    expect((await aiCapabilities.queries["code.run.read"].run({ codeId: code.id, runId, cursor: 0 }, codeContext)).ok).toBe(false);
    await sql`DELETE FROM code.codes WHERE id=${resource.id}`;
    expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${account.id}::uuid`).toHaveLength(0);
  });
  test("live resource admins are default editors, removed admins lose access, ordinary owner readers get no Code rights", async () => {
    const resource = await createCode(
      { owner: { kind: "resource", ref: { type: "example.mailbox", id: "live-admin" } }, title: "Resource" },
      ctx(ids.admin, true),
    );
    ownerState.set(ids.stranger, { title: "Renamed mailbox", admin: true });
    expect((await readCode(resource.id, ctx(ids.stranger))).permission).toBe("editor");
    expect(await access.codeAccountDisplayName(resource, { ...ctx(ids.stranger), locale: "de" })).toBe("Code von Renamed mailbox");
    ownerState.set(ids.stranger, { title: "Renamed again", admin: false });
    await expect(readCode(resource.id, ctx(ids.stranger))).rejects.toThrow("Code not found");
    ownerState.delete(ids.stranger);
    expect(await sql<{ name: string }[]>`SELECT name FROM auth.service_accounts WHERE id=${resource.serviceAccountId}::uuid`).toEqual([
      { name: "code:example.mailbox:live-admin" },
    ]);
  });
  test("each resource/app has at most one Code; a person can have several, with isolated version/run identities", async () => {
    const input = { owner: { kind: "app" as const, appId: "example" }, title: "App Code" };
    const [a, b] = await Promise.allSettled([createCode(input, ctx(ids.admin, true)), createCode(input, ctx(ids.admin, true))]);
    expect([a, b].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const personal = await createCode({ owner: { kind: "person", userId: ids.owner }, title: "Another" }, ctx(ids.owner));
    expect(personal.id).not.toBe(code.id);
    expect(personal.serviceAccountId).toBeNull();
    await expect(readCodeVersion({ codeId: personal.id, versionId, offset: 0, length: 100 }, ctx(ids.owner))).rejects.toThrow("not found");
    await expect((async () => await sql`UPDATE code.codes SET id='c_changed' WHERE id=${personal.id}`)()).rejects.toThrow("immutable");
  });
  test("versions preserve exact UTF-8 source/bundle and hashes, reject stale base and in-place changes", async () => {
    const version = await readCodeVersion(
      { codeId: code.id, versionId, offset: 0, length: 100, content: { kind: "bundle" } },
      ctx(ids.reader),
    );
    expect(version.content?.text).toBe("export default 'bundle';");
    expect(version.version.sourceHash).toBe(codeSourceHash({ "code.ts": "export default 'source';" }));
    expect(version.version.bundleHash).toBe(codeBundleHash("export default 'bundle';"));
    await expect((async () => await sql`UPDATE code.versions SET bundle='changed' WHERE id=${versionId}::uuid`)()).rejects.toThrow(
      "immutable",
    );
    await expect((async () => await sql`UPDATE code.versions SET manifest='{}'::jsonb WHERE id=${versionId}::uuid`)()).rejects.toThrow(
      "immutable",
    );
    await expect(
      createCodeVersion(
        { codeId: code.id, sourceFiles: { "code.ts": "new" }, bundle: "new", manifest: null, baseVersionId: null },
        ctx(ids.editor),
      ),
    ).rejects.toThrow("newer");
    await expect(
      createCodeVersion(
        { codeId: code.id, sourceFiles: { "code.ts": "x".repeat(1_048_577) }, bundle: "new", manifest: null, baseVersionId: versionId },
        ctx(ids.editor),
      ),
    ).rejects.toThrow("storage limits");
  });
  test("sharing uses normal grant precedence and revocation; readers cannot share or save versions", async () => {
    const grant = await addCodeAccess(code.id, { type: "user", userId: ids.stranger }, "editor", ctx(ids.editor));
    expect((await readCode(code.id, ctx(ids.stranger))).permission).toBe("editor");
    await removeCodeAccess(code.id, grant, ctx(ids.owner));
    await expect(readCode(code.id, ctx(ids.stranger))).rejects.toThrow();
    await expect(addCodeAccess(code.id, { type: "user", userId: ids.stranger }, "reader", ctx(ids.reader))).rejects.toThrow();
    await expect(
      createCodeVersion(
        { codeId: code.id, sourceFiles: { "code.ts": "x" }, bundle: "x", manifest: null, baseVersionId: versionId },
        ctx(ids.reader),
      ),
    ).rejects.toThrow();
  });
  test("creator deletion erases attribution without deleting resource Code, its account or immutable versions", async () => {
    const resource = await createCode(
      { owner: { kind: "resource", ref: { type: "example.mailbox", id: "creator-deletion" } }, title: "Survives" },
      ctx(ids.creator, true),
    );
    const version = await createCodeVersion(
      { codeId: resource.id, sourceFiles: { "code.ts": "x" }, bundle: "x", manifest: null, baseVersionId: null },
      ctx(ids.creator, true),
    );
    await sql`DELETE FROM auth.users WHERE id=${ids.creator}::uuid`;
    expect(await sql<{ created_by: string | null }[]>`SELECT created_by FROM code.codes WHERE id=${resource.id}`).toEqual([
      { created_by: null },
    ]);
    expect(await sql<{ created_by: string | null }[]>`SELECT created_by FROM code.versions WHERE id=${version.id}::uuid`).toEqual([
      { created_by: null },
    ]);
    expect(
      await sql<{ created_by: string | null }[]>`SELECT created_by FROM auth.service_accounts WHERE id=${resource.serviceAccountId}::uuid`,
    ).toEqual([{ created_by: null }]);
  });
  test("run storage limits apply to calls and results; retention starts at end, cascades calls and preserves versions", async () => {
    const old = new Date("2026-09-01T00:00:00.000Z");
    await sql`UPDATE code.runs SET created_at=${old},started_at=${old},state='succeeded',ended_at=${new Date("2026-10-01T12:00:00.000Z")} WHERE id=${runId}::uuid`;
    const active = await insertCodeRun({ codeId: code.id, versionId, trigger: "schedule", entrypoint: "still-running", input: null });
    await sql`UPDATE code.runs SET created_at=${old},state='running' WHERE id=${active}::uuid`;
    await expect(
      sql.begin(async (tx) => {
        await appendCodeCall(
          {
            runId: active,
            kind: "query",
            call: { capability: "example.item.read", target: null, refs: {}, input: { large: "x".repeat(32768) } },
          },
          tx,
        );
      }),
    ).rejects.toThrow("storage limit");
    expect(await expireCodeRuns({ now: new Date("2026-10-31T11:59:59.000Z"), limit: 100 })).toBe(0);
    expect(await expireCodeRuns({ now: fixed, limit: 100 })).toBe(1);
    expect(await sql`SELECT * FROM code.calls WHERE run_id=${runId}::uuid`).toHaveLength(0);
    expect(await sql`SELECT * FROM code.runs WHERE id=${active}::uuid`).toHaveLength(1);
    expect(await sql`SELECT * FROM code.versions WHERE id=${versionId}::uuid`).toHaveLength(1);
  });
  test("personal owner deletion cascades Code, versions, runs and access entries", async () => {
    const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM code.access WHERE code_id=${code.id}`;
    await sql`DELETE FROM auth.users WHERE id=${ids.owner}::uuid`;
    expect(await sql`SELECT id FROM code.codes WHERE id=${code.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM code.runs WHERE code_id=${code.id}`).toHaveLength(0);
    for (const grant of grants) expect(await sql`SELECT id FROM auth.access WHERE id=${grant.access_id}::uuid`).toHaveLength(0);
  });
});
