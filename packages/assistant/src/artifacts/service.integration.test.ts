import { beforeAll, afterAll, describe, expect, test, spyOn } from "bun:test";
import { aiConversations } from "@k2b/cloud/ai";
import { sql } from "bun";
import { migrateArtifacts } from "./migrate";
import { artifacts } from "./service";
import { testIdentity } from "./test-identity";
import { artifactCapabilities } from "./capabilities";

import { clientCalls } from "./client-calls";

const isolated = /\/cloud_assistant_artifacts_test(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
(isolated ? describe : describe.skip)("Assistant artifacts in disposable Postgres", () => {
  const owner = testIdentity("00000000-0000-4000-8000-000000000001");
  const reader = testIdentity("00000000-0000-4000-8000-000000000002");
  const editor = testIdentity("00000000-0000-4000-8000-000000000003");
  const stranger = testIdentity("00000000-0000-4000-8000-000000000004");
  const source = { entry: "main.js", files: [{ path: "main.js", content: "export default () => 1" }] };
  let id = "";
  beforeAll(async () => {
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin')`;
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY)`;
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text)`;
    await sql`CREATE TABLE auth.user_groups_v2(user_id uuid,group_id uuid)`;
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`;
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,group_id uuid,service_account_id uuid,authenticated_only boolean DEFAULT false,permission auth.permission_level)`;
    for (const who of [owner,reader,editor,stranger]) await sql`INSERT INTO auth.users VALUES(${who.user!.id}::uuid)`;
    await migrateArtifacts();
    await migrateArtifacts();
    id = (await artifacts.create({ title: "Analysis", source },owner)).id;
    // Fixtures use the canonical access rows; grant mutation checks are tested below.
    for (const [who,permission] of [[reader,"read"],[editor,"write"]] as const) {
      const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${who.user!.id}::uuid,${permission}::auth.permission_level) RETURNING id`;
      await sql`INSERT INTO assistant.artifact_access VALUES(${id}::uuid,${grant!.id}::uuid)`;
    }
  });
  afterAll(async () => { await sql.close(); });

  test("context titles expose only currently accessible apps", async () => {
    expect(await artifacts.describe([id, "invalid"], owner.user.id)).toEqual([{ id, title: "Analysis", description: "" }]);
    expect(await artifacts.describe([id], stranger.user.id)).toEqual([]);
  });
  test("descriptions round-trip without source writes erasing them", async () => {
    const app = await artifacts.create({ title: "Described", description: "Calculate a tip.", source }, owner);
    expect(app.description).toBe("Calculate a tip.");
    const saved = await artifacts.writeFile(app.id, "main.js", "export default () => 2", owner);
    expect(saved.description).toBe("Calculate a tip.");
    expect((await artifacts.describe([app.id], owner.user!.id))[0]?.description).toBe("Calculate a tip.");
    const updated = await artifacts.update(app.id, { title: app.title, description: "Updated description.", expectedRevision: saved.revision, source }, owner);
    expect(updated.description).toBe("Updated description.");
  });
  test("use, edit and manage are independently enforced", async () => {
    expect((await artifacts.get(id,reader)).source).toEqual(source);
    expect((await artifacts.list(stranger)).items).toHaveLength(0);
    await expect(artifacts.get(id,stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(artifacts.update(id,{ title: "Changed", source, expectedRevision: 1 },reader)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(artifacts.grant(id,{ type: "authenticated" },"read",editor)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(artifacts.history(id,stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  test("concurrent saves retain the old immutable source and reject a stale writer", async () => {
    const outcomes = await Promise.allSettled([2,3].map((value) => artifacts.update(id,{
      title: "Updated", expectedRevision: 1,
      source: { entry: "main.js", files: [{ path: "main.js", content: `export default () => ${value}` }] },
    },editor)));
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await artifacts.get(id,reader,1)).source).toEqual(source);
    expect((await artifacts.get(id,reader)).revision).toBe(2);
    expect((await artifacts.history(id,reader)).items.map((item) => item.revision)).toEqual([2,1]);
  });

  test("an unrelated chat lifecycle cannot cascade artifact deletion", async () => {
    const constraints = await sql<{ target: string }[]>`SELECT confrelid::regclass::text AS target
      FROM pg_constraint WHERE conrelid='assistant.artifacts'::regclass AND contype='f'`;
    expect(constraints).toHaveLength(0);
    expect((await artifacts.get(id,owner)).id).toBe(id);
  });

  test("the final manager cannot be removed and foreign grants cannot be changed", async () => {
    const [grant] = await sql<{ access_id: string }[]>`SELECT link.access_id FROM assistant.artifact_access link
      JOIN auth.access a ON a.id=link.access_id WHERE link.artifact_id=${id}::uuid AND a.permission='admin'`;
    await expect(artifacts.changeGrant(id,grant!.access_id,null,owner)).rejects.toMatchObject({ code: "LAST_MANAGER" });
    await expect(artifacts.changeGrant(id,crypto.randomUUID(),null,owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("agent file writes persist incomplete code, preserve helpers and enforce permissions", async () => {
    const context = { ...owner, locale: "en", requestId: crypto.randomUUID(), origin: "assistant" as const, signal: new AbortController().signal };
    const created = await artifactCapabilities.actions.code_create.run({ title: "Agent test" }, context);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.data.id;
    const write = (path: string, content: string) => artifactCapabilities.actions.code_write.run({ id, path, content }, context);
    const intermediate = await write("main.ts", 'import {value} from "./helper.ts"; export default () => value;');
    expect(intermediate).toMatchObject({ ok: true, data: { data: { saved: true } } });
    if (!intermediate.ok) throw new Error("Write failed");
    expect(intermediate.data.data.diagnostics.length).toBeGreaterThan(0);
    expect(await write("helper.ts", "export const value = 42;"))
      .toMatchObject({ ok: true, data: { data: { saved: true, diagnostics: [] } } });
    expect((await artifacts.get(id, owner)).source.files).toHaveLength(2);
    await Promise.all([write("a.ts", "export const a=1;"), write("b.ts", "export const b=2;")]);
    expect((await artifacts.get(id, owner)).source.files).toHaveLength(4);
    await write("main.ts", "export default !!!");
    expect(await artifactCapabilities.queries.code_read.run({ id, path: "main.ts", offset: 0 }, context))
      .toMatchObject({ ok: true, data: { data: { content: "export default !!!", complete: true } } });
    expect(await artifactCapabilities.actions.code_write.run({ id, path: "main.ts", content: "x" }, { ...context, ...stranger }))
      .toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
    expect(await artifactCapabilities.actions.code_remove.run({ id, path: "main.ts" }, context))
      .toMatchObject({ ok: true, data: { data: { removed: true } } });
    expect((await artifacts.get(id, owner)).source.files).toHaveLength(3);
    expect(await write("main.ts", "export default () => 42;"))
      .toMatchObject({ ok: true, data: { data: { diagnostics: [] } } });
  });

  test("two browsers cannot execute one tool call twice and interrupted claims never replay", async () => {
    const conversationId = crypto.randomUUID(), turnId = crypto.randomUUID();
    const input = { operation: "open" as const, id };
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) => request.ownerUserId !== owner.user.id ? null : ({
      id: conversationId, shortId: "abcdef", title: "Test", titleSource: "user", description: "", descriptionSource: "user",
      keywords: [], pinnedAt: null, archivedAt: null, runStatus: "needs_attention", runError: null, unreadCompletion: false,
      projectId: null, draft: { content: [], revision: 1, updatedAt: null }, createdByUserId: owner.user.id,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const turn = spyOn(aiConversations, "getActiveTurn").mockResolvedValue({
      turn: { id: turnId, shortId: "ghijkl", conversationId, status: "waiting_for_action", attempt: 1,
        modelProfileId: null, createdAt: new Date().toISOString(), completedAt: null, error: null },
      liveBlocks: [{ id: "block", kind: "tool", callId: "call", name: "code_open", args: { id }, status: "awaiting_client", frontendMode: "client" }], liveSeq: 1,
    });
    const first = { conversationId, turnId: "ghijkl", callId: "call", clientId: crypto.randomUUID(), input };
    const second = { ...first, turnId, clientId: crypto.randomUUID() };
    try {
      await expect(clientCalls.claim({ ...first, turnId: "wrong1" }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
      const claims = await Promise.all([clientCalls.claim(first, owner), clientCalls.claim(second, owner)]);
      expect(claims.map((claim) => claim.status).sort()).toEqual(["execute", "pending"]);
      const winner = claims[0]!.status === "execute" ? first : second;
      const loser = winner === first ? second : first;
      await expect(clientCalls.complete({ ...loser, result: { opened: id } }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
      await clientCalls.complete({ ...winner, result: { opened: id } }, owner);
      expect(await clientCalls.claim(loser, owner)).toEqual({ status: "done", result: { opened: id } });
      await expect(clientCalls.claim(first, stranger)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(clientCalls.claim({ ...first, input: { ...input, id: crypto.randomUUID() } }, owner)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await sql`UPDATE assistant.artifact_client_calls SET result=NULL, created_at=now()-interval '61 seconds' WHERE turn_id=${turnId}::uuid`;
      expect(await clientCalls.claim(first, owner)).toEqual({ status: "interrupted" });
      await expect(clientCalls.complete({ ...winner, result: {} }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally { conversation.mockRestore(); turn.mockRestore(); }
  });
});
