import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import * as cloudRuntime from "@k2b/cloud";
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
  addCodeShare,
  appendCodeCall,
  codeBundleHash,
  codeSourceHash,
  createCode,
  createCodeVersion,
  expireCodeRuns,
  finishCodeCall,
  insertCodeRun,
  listCodeRuns,
  listCodes,
  readCode,
  readCodeRun,
  readCodeVersion,
  removeCodeShare,
} from "./store";

const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  editor: "22222222-2222-4222-8222-222222222222",
  reader: "33333333-3333-4333-8333-333333333333",
  stranger: "44444444-4444-4444-8444-444444444444",
  admin: "55555555-5555-4555-8555-555555555555",
  creator: "66666666-6666-4666-8666-666666666666",
};
const actualReadCodeOwner = access.readCodeOwner;
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
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code");
    await migrateAuth();
    await migrateCode(); // Forward on an empty identity database.
    for (const [name, id] of Object.entries(ids))
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${name},'local','user',${name === "admin"})`;
    // Forward migration over an already populated identity database.
    await migrateCode();
    settingsSpy = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!definition) throw new Error(`Unexpected setting ${key}`);
      return definition.default;
    });
    ownerState.set(ids.admin, { title: "Mailbox today", admin: true });
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
    await addCodeShare(code.id, { type: "user", userId: ids.editor }, "editor", ctx(ids.owner));
    await addCodeShare(code.id, { type: "user", userId: ids.reader }, "reader", ctx(ids.owner));
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
    setSystemTime();
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
      const run = await aiCapabilities.queries["code.run.read"].run({ codeId: code.id, runId, cursor: 0, offset: 0, length: 16384 }, c);
      for (const response of [read, version, runs, run]) expect(response.ok).toBe(allowed);
      if (run.ok) {
        expect(codeQueryContracts.runRead.data.safeParse(run.data.data).success).toBe(true);
        if (id === ids.reader || id === ids.admin) {
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
    const second = await aiCapabilities.queries["code.run.read"].run(
      { codeId: code.id, runId, cursor: 1, offset: 0, length: 16384 },
      context(ids.owner),
    );
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
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${code.id},${grant!.id}::uuid)`;
    expect((await aiCapabilities.queries["code.list"].run({ limit: 20 }, codeContext)).ok).toBe(false);
    expect((await aiCapabilities.queries["code.read"].run({ codeId: code.id }, codeContext)).ok).toBe(false);
    expect(
      (await aiCapabilities.queries["code.version.read"].run({ codeId: code.id, versionId, offset: 0, length: 100 }, codeContext)).ok,
    ).toBe(false);
    expect((await aiCapabilities.queries["code.run.list"].run({ codeId: code.id, limit: 20 }, codeContext)).ok).toBe(false);
    expect(
      (await aiCapabilities.queries["code.run.read"].run({ codeId: code.id, runId, cursor: 0, offset: 0, length: 16384 }, codeContext)).ok,
    ).toBe(false);
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
    expect(await access.codeAccountDisplayName(resource, { ...ctx(ids.stranger), locale: "DE-at" })).toBe("Code von Renamed again");
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
    const grant = await addCodeShare(code.id, { type: "user", userId: ids.stranger }, "editor", ctx(ids.editor));
    expect((await readCode(code.id, ctx(ids.stranger))).permission).toBe("editor");
    await removeCodeShare(code.id, grant, ctx(ids.owner));
    await expect(readCode(code.id, ctx(ids.stranger))).rejects.toThrow();
    await expect(addCodeShare(code.id, { type: "user", userId: ids.stranger }, "reader", ctx(ids.reader))).rejects.toThrow();
    await expect(
      createCodeVersion(
        { codeId: code.id, sourceFiles: { "code.ts": "x" }, bundle: "x", manifest: null, baseVersionId: versionId },
        ctx(ids.reader),
      ),
    ).rejects.toThrow();
  });
  test("creator deletion erases attribution without deleting resource Code, its account or immutable versions", async () => {
    ownerState.set(ids.creator, { title: "Survives", admin: true });
    const resource = await createCode(
      { owner: { kind: "resource", ref: { type: "example.mailbox", id: "creator-deletion" } }, title: "Survives" },
      ctx(ids.creator, true),
    );
    const version = await createCodeVersion(
      { codeId: resource.id, sourceFiles: { "code.ts": "x" }, bundle: "x", manifest: null, baseVersionId: null },
      ctx(ids.creator, true),
    );
    ownerState.delete(ids.creator);
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
  test("personal creation stays with its person; non-person owners must exist even for administrators", async () => {
    await expect(
      createCode({ owner: { kind: "person", userId: ids.owner }, title: "Other person" }, ctx(ids.admin, true)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    ownerSpy.mockResolvedValueOnce(null);
    await expect(
      createCode({ owner: { kind: "resource", ref: { type: "example.mailbox", id: "missing" } }, title: "Missing" }, ctx(ids.admin, true)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    ownerSpy.mockResolvedValueOnce(null);
    await expect(createCode({ owner: { kind: "app", appId: "missing" }, title: "Missing" }, ctx(ids.admin, true))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  test("creation requires actual owner administration even for Cloud administrators", async () => {
    ownerSpy.mockResolvedValueOnce({ title: "Existing owner", admin: false });
    await expect(
      createCode({ owner: { kind: "resource", ref: { type: "example.mailbox", id: "not-admin" } }, title: "Denied" }, ctx(ids.admin, true)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("shares upsert one principal and permission changes take effect", async () => {
    const first = await addCodeShare(code.id, { type: "user", userId: ids.editor }, "reader", ctx(ids.owner));
    const second = await addCodeShare(code.id, { type: "user", userId: ids.editor }, "editor", ctx(ids.owner));
    expect(second).toBe(first);
    expect(
      await sql`SELECT a.id FROM code.shares j JOIN auth.access a ON a.id=j.access_id WHERE j.code_id=${code.id} AND a.user_id=${ids.editor}::uuid`,
    ).toHaveLength(1);
    expect((await readCode(code.id, ctx(ids.editor))).permission).toBe("editor");
  });
  test("Cloud administration gives reader visibility; writes and run contents require normal editor rights", async () => {
    const personal = await createCode({ owner: { kind: "person", userId: ids.owner }, title: "Own authority" }, ctx(ids.owner));
    expect((await readCode(personal.id, ctx(ids.admin, true))).permission).toBe("reader");
    const version = { codeId: personal.id, sourceFiles: { "code.ts": "x" }, bundle: "x", manifest: null, baseVersionId: null };
    await expect(createCodeVersion(version, ctx(ids.admin, true))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addCodeShare(personal.id, { type: "user", userId: ids.stranger }, "editor", ctx(ids.admin, true))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const grant = await addCodeShare(personal.id, { type: "user", userId: ids.admin }, "editor", ctx(ids.owner));
    expect((await createCodeVersion(version, ctx(ids.admin, true))).codeId).toBe(personal.id);
    await removeCodeShare(personal.id, grant, ctx(ids.owner));
    expect((await readCode(personal.id, ctx(ids.admin, true))).permission).toBe("reader");
  });
  test("a provider outage preserves explicit reader visibility", async () => {
    const resource = await createCode(
      { owner: { kind: "resource", ref: { type: "example.mailbox", id: "reader-outage" } }, title: "Readable" },
      ctx(ids.admin, true),
    );
    await addCodeShare(resource.id, { type: "user", userId: ids.reader }, "reader", ctx(ids.admin, true));
    ownerSpy.mockRejectedValueOnce(new access.CodeOwnerUnavailableError("Provider offline"));
    expect((await readCode(resource.id, ctx(ids.reader))).permission).toBe("reader");
    ownerSpy.mockRejectedValueOnce(new access.CodeOwnerUnavailableError("Provider offline"));
    await expect(
      createCodeVersion(
        { codeId: resource.id, sourceFiles: { "code.ts": "x" }, bundle: "x", manifest: null, baseVersionId: null },
        ctx(ids.reader),
      ),
    ).rejects.toBeInstanceOf(access.CodeOwnerUnavailableError);
  });
  test("unfiltered lists avoid remote owner scans; exact owners check live administration", async () => {
    const resource = await createCode(
      { owner: { kind: "resource", ref: { type: "example.mailbox", id: "list-admin" } }, title: "Resource" },
      ctx(ids.admin, true),
    );
    ownerState.set(ids.stranger, { title: "Mailbox", admin: true });
    ownerSpy.mockClear();
    const unfiltered = await listCodes({ limit: 20 }, ctx(ids.stranger));
    expect(unfiltered.items.some((item) => item.id === resource.id)).toBe(false);
    expect(ownerSpy).not.toHaveBeenCalled();
    const adminList = await listCodes({ limit: 20 }, ctx(ids.admin, true));
    expect(adminList.items.some((item) => item.id === resource.id)).toBe(true);
    expect(ownerSpy).not.toHaveBeenCalled();
    const filtered = await listCodes({ owner: resource.owner, limit: 20 }, ctx(ids.stranger));
    expect(filtered.items.some((item) => item.id === resource.id)).toBe(true);
    ownerState.delete(ids.stranger);
  });
  test("JSON admission measures Postgres whitespace, rejects NUL and leaves no partial run", async () => {
    const input = Array.from({ length: 12000 }, () => 0); // 24001 compact bytes; 36000 jsonb bytes.
    await expect(insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "boundary", input })).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    const invalidInputs: Record<string, string>[] = [{ value: "bad\u0000" }, { ["bad\u0000"]: "key" }, { value: "\ud800" }];
    for (const input of invalidInputs)
      await expect(
        insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "invalid-text", input }),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });
    for (const [sourceFiles, bundle] of [
      [{ "code.ts": "bad\u0000" }, "good"],
      [{ "code.ts": "good" }, "bad\u0000"],
    ] as const)
      await expect(
        createCodeVersion({ codeId: code.id, sourceFiles, bundle, manifest: null, baseVersionId: versionId }, ctx(ids.owner)),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(await sql`SELECT id FROM code.runs WHERE entrypoint IN ('boundary','invalid-text')`).toHaveLength(0);
  });
  test("valid large results finish and remain readable in full through bounded chunks", async () => {
    const largeRun = await insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "large-result", input: null });
    const result = {
      rows: "ä😀".repeat(20000),
      numbers: Array.from({ length: 1000 }, () => 1e100),
      escaped: "NUL\u0000",
      surrogate: "\ud800",
    };
    await sql.begin(async (tx) => {
      const ordinal = await appendCodeCall(
        { runId: largeRun, kind: "query", call: { capability: "example.item.read", target: null, refs: {}, input: {} } },
        tx,
      );
      await finishCodeCall({ runId: largeRun, ordinal, state: "succeeded", result, endedAt: fixed }, tx);
    });
    const [saved] = await sql<{ state: string; result: unknown }[]>`SELECT state,result FROM code.calls WHERE run_id=${largeRun}::uuid`;
    expect(saved).toEqual({ state: "succeeded", result });
    const page = await readCodeRun({ codeId: code.id, runId: largeRun }, ctx(ids.owner));
    expect(page.contents?.calls[0]).toMatchObject({ result: null, resultChunked: true, state: "succeeded" });
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const chunk = await readCodeRun(
        { codeId: code.id, runId: largeRun, content: { kind: "result", ordinal: 1 }, offset },
        ctx(ids.owner),
      );
      expect(codeQueryContracts.runRead.data.safeParse(chunk).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(262144);
      if (!chunk.contents?.content) throw new Error("Missing result chunk");
      text += chunk.contents.content.text;
      offset = chunk.contents.content.nextOffset;
    }
    expect(JSON.parse(text)).toEqual(result);
    expect(
      (await readCodeRun({ codeId: code.id, runId: largeRun, content: { kind: "result", ordinal: 1 } }, ctx(ids.reader))).contents,
    ).toBeNull();
  });
  test("out-of-contract results finish visibly instead of leaving calls running", async () => {
    const run = await insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "bad-result", input: null });
    for (const result of ["x".repeat(262145)]) {
      await sql.begin(async (tx) => {
        const ordinal = await appendCodeCall(
          { runId: run, kind: "query", call: { capability: "example.item.read", target: null, refs: {}, input: {} } },
          tx,
        );
        await finishCodeCall({ runId: run, ordinal, state: "succeeded", result, endedAt: fixed }, tx);
      });
    }
    const calls = await sql<
      { state: string; result: { code: string } }[]
    >`SELECT state,result FROM code.calls WHERE run_id=${run}::uuid ORDER BY ordinal`;
    expect(calls.map((call) => call.state)).toEqual(["succeeded"]);
    expect(calls.map((call) => call.result.code)).toEqual(["code_result_exceeds_capability_contract"]);
  });
  test("run keyset pages keep exact microseconds and ignore newer insertions", async () => {
    const a = await insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "keyset-a", input: null });
    const b = await insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "keyset-b", input: null });
    await sql`UPDATE code.runs SET created_at='2026-10-30T12:00:00.000002Z' WHERE code_id=${code.id}`;
    await sql`UPDATE code.runs SET created_at='2026-10-30T12:00:00.000003Z' WHERE id=${a}::uuid`;
    const first = await listCodeRuns({ codeId: code.id, limit: 1 }, ctx(ids.owner));
    expect(first.items[0]?.id).toBe(a);
    expect(first.nextCursor).toContain("000003Z");
    const newer = await insertCodeRun({ codeId: code.id, versionId, trigger: "manual", entrypoint: "keyset-new", input: null });
    const second = await listCodeRuns({ codeId: code.id, limit: 50, cursor: first.nextCursor! }, ctx(ids.owner));
    expect(second.items.some((item) => item.id === b)).toBe(true);
    expect(second.items.some((item) => item.id === a || item.id === newer)).toBe(false);
  });
  test("immutable versions reject individual deletion while owning Code still exists", async () => {
    await expect((async () => await sql`DELETE FROM code.versions WHERE id=${versionId}::uuid`)()).rejects.toThrow("immutable version");
  });
  test("an application administrator with a read-only credential can read its Code ownership", async () => {
    const registry = spyOn(cloudRuntime, "getApp").mockResolvedValue({
      id: "scope-app",
      name: "Scope App",
      icon: "ti ti-code",
      description: "Fixture",
      routes: ["/scope-app"],
      baseUrl: "http://scope-app.test",
      access: { kind: "grants" },
    });
    try {
      await sql`INSERT INTO auth.app_access_state(app_id) VALUES('scope-app')`;
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${ids.owner}::uuid,'admin') RETURNING id`;
      if (!grant) throw new Error("Missing admin grant");
      await sql`INSERT INTO auth.app_access(app_id,access_id) VALUES('scope-app',${grant.id}::uuid)`;
      const readOnly: access.CodeContext = { authority: { ...authority(ids.owner), credentialKind: "oauth", scopes: ["core:read"] } };
      expect(await actualReadCodeOwner({ kind: "app", appId: "scope-app" }, readOnly)).toEqual({ title: "Scope App", admin: true });
      expect(() => access.codePerson(readOnly, true)).toThrow("Credential");
    } finally {
      registry.mockRestore();
    }
  });
  test("personal owner deletion cascades Code, versions, runs and access entries", async () => {
    const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM code.shares WHERE code_id=${code.id}`;
    await sql`DELETE FROM auth.users WHERE id=${ids.owner}::uuid`;
    expect(await sql`SELECT id FROM code.codes WHERE id=${code.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM code.versions WHERE code_id=${code.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM code.runs WHERE code_id=${code.id}`).toHaveLength(0);
    for (const grant of grants) expect(await sql`SELECT id FROM auth.access WHERE id=${grant.access_id}::uuid`).toHaveLength(0);
  });
});
