import { evaluateCodeMode } from "./code-mode.eval";
import { loadAssistantChatContextSnapshot } from "../chat-context";
import { agentHost } from "./agent-host";
import { httpService } from "./http-service";
import { secrets } from "@k2b/cloud/services";
import { HttpPrepare } from "./http-contracts";
import {importRows} from "../../examples/accounting/import-rows";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities } from "@k2b/cloud/contracts";
import { z } from "zod";
import { ok } from "@k2b/stdlib";
import { runtimeCapabilities } from "./capability-runtime";
import { beforeAll, afterAll, describe, expect, test, spyOn } from "bun:test";
import { aiConversations, aiProjects, aiToolAudit, aiChatTasks } from "@k2b/cloud/ai";
import { sql } from "bun";
import { migrateArtifacts } from "./migrate";
import { artifacts } from "./service";
import { testIdentity } from "./test-identity";
import { artifactCodeHandlers } from "./code-tools";

import { artifactAdmin, adminIdentity } from "./admin";
import { app } from "../config";
import { artifactDatabase } from "./database";
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
    await sql`CREATE SCHEMA ai`;
    await sql`CREATE TABLE ai.conversations(id uuid PRIMARY KEY,created_by_user_id uuid,archived_at timestamptz)`;
    await sql`CREATE TABLE ai.turns(id uuid PRIMARY KEY,status text)`;
    await sql`CREATE TABLE ai.files(conversation_id uuid,path text,bytes bytea,size bigint,media_type text,origin text,producer_call_key text,dictation_recorded_at timestamptz,updated_at timestamptz DEFAULT now(),version bigint DEFAULT 1,PRIMARY KEY(conversation_id,path))`;
    await sql`CREATE TABLE ai.dictations(conversation_id uuid,source_bytes bytea)`;

    await sql`CREATE TABLE ai.tool_calls(request_id text,conversation_id uuid,turn_id uuid,location text,call_id text,tool_name text,status text,started_at timestamptz,UNIQUE(turn_id,call_id))`;
    await sql`CREATE TABLE ai.tool_approval_preferences(id uuid DEFAULT gen_random_uuid(),actor_user_id uuid,tool_name text,approval_scope text,created_at timestamptz DEFAULT now(),last_used_at timestamptz,expires_at timestamptz)`;
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin')`;
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY, display_name text DEFAULT 'Test', uid text DEFAULT 'test', avatar_hash text)`;
    await sql`CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text)`;
    await sql`CREATE TABLE auth.user_groups_v2(user_id uuid,group_id uuid)`;
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id uuid,child_group_id uuid)`;
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,group_id uuid,service_account_id uuid,authenticated_only boolean DEFAULT false,permission auth.permission_level,created_at timestamptz DEFAULT now())`;
    for (const who of [owner,reader,editor,stranger]) await sql`INSERT INTO auth.users(id) VALUES(${who.user!.id}::uuid)`;
    await migrateArtifacts();
    await migrateArtifacts();
    id = (await artifacts.create({ title: "Analysis", source },owner)).id;
    // Fixtures use the canonical access rows; grant mutation checks are tested below.
    for (const [who,permission] of [[reader,"read"],[editor,"write"]] as const) {
      const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${who.user!.id}::uuid,${permission}::auth.permission_level) RETURNING id`;
      await sql`INSERT INTO assistant.artifact_access VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${id}),${grant!.id}::uuid)`;
    }
  });
  afterAll(async () => { await sql.close(); });

  test("personal HTTP secrets stay encrypted, scoped and bound; requests execute only once", async () => {
    const resource=await artifacts.create({title:"HTTP test",source},owner);
    const scope={resourceId:resource.id};
    await artifacts.publish(resource.id,resource.revision,owner,"HTTP fixture");
    await artifacts.grant(resource.id,{type:"user",userId:reader.user.id},"read",owner);
    const saved=await httpService.save(scope,{name:"crm",origin:"https://api.example.com",header:"authorization",prefix:"Bearer ",value:"fixture-key-not-public",expectedRevision:null},owner);
    expect(JSON.stringify(saved)).not.toContain("fixture-key");
    expect(JSON.stringify(await httpService.list(scope,owner))).not.toContain("encrypted");
    expect(await httpService.list(scope,reader)).toEqual([]);
    const [stored]=await sql<{encrypted:string}[]>`SELECT encrypted FROM assistant.http_secrets WHERE user_id=${owner.user.id}::uuid AND scope=${"resource:"+resource.id}`;
    expect(stored!.encrypted).not.toContain("fixture-key");
    expect(await secrets.decrypt<string>(stored!.encrypted)).toBe("fixture-key-not-public");
    const make=()=>HttpPrepare.parse({id:crypto.randomUUID(),createdAt:Date.now(),scope,request:{url:"https://api.example.com/v1/items",method:"POST",headers:{Authorization:{secret:"crm",prefix:"Bearer "}},body:btoa("hello")}});
    await expect(httpService.prepare(make(),reader)).rejects.toMatchObject({code:"HTTP_SECRET"});
    await expect(httpService.list(scope,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    const other=await artifacts.create({title:"Other context",source},owner);
    await expect(httpService.prepare({...make(),scope:{resourceId:other.id}},owner)).rejects.toMatchObject({code:"HTTP_SECRET"});
    for (const request of [
      {...make().request,url:"https://other.example.com/v1/items"},
      {...make().request,headers:{"x-api-key":{secret:"crm",prefix:"Bearer "}}},
      {...make().request,headers:{authorization:{secret:"crm",prefix:""}}},
    ]) await expect(httpService.prepare({...make(),request},owner)).rejects.toMatchObject({code:"HTTP_SECRET"});
    const call=make();
    expect(JSON.stringify(await httpService.prepare(call,owner))).not.toContain("fixture-key");
    expect(await httpService.prepare(call,owner)).toMatchObject({id:call.id});
    await expect(httpService.prepare({...call,request:{...call.request,url:"https://api.example.com/different"}},owner)).rejects.toMatchObject({code:"HTTP_UNKNOWN"});
    let sent=0;
    const send:Parameters<typeof httpService.execute>[4]=async request=>{
      sent++;expect(request.headers.authorization).toBe("Bearer fixture-key-not-public");
      expect(new TextDecoder().decode(request.body)).toBe("hello");
      return {status:429,headers:{"retry-after":"2"},body:new TextEncoder().encode("rate limited")};
    };
    const results=await Promise.allSettled([httpService.execute(call.id,true,owner,new AbortController().signal,send),httpService.execute(call.id,true,owner,new AbortController().signal,send)]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(sent).toBe(1);
    await expect(httpService.execute(call.id,true,owner,new AbortController().signal,send)).rejects.toMatchObject({code:"HTTP_UNKNOWN"});
    const uncertain=make();await httpService.prepare(uncertain,owner);
    await expect(httpService.execute(uncertain.id,true,owner,new AbortController().signal,async()=>{sent++;throw new Error("fixture-key-not-public");})).rejects.toMatchObject({message:"HTTP_UNKNOWN"});
    await expect(httpService.execute(uncertain.id,true,owner,new AbortController().signal,send)).rejects.toMatchObject({code:"HTTP_UNKNOWN"});expect(sent).toBe(2);
    const denied=make();await httpService.prepare(denied,owner);
    await expect(httpService.execute(denied.id,false,owner,new AbortController().signal,send)).rejects.toMatchObject({code:"HTTP_DENIED"});expect(sent).toBe(2);
    const changed=make();await httpService.prepare(changed,owner);
    const replacement=await httpService.save(scope,{...saved,value:"replacement",expectedRevision:saved.revision},owner);
    await expect(httpService.execute(changed.id,true,owner,new AbortController().signal,send)).rejects.toMatchObject({code:"HTTP_CONFLICT"});
    await expect(httpService.remove(scope,"crm",saved.revision,owner)).rejects.toMatchObject({code:"HTTP_CONFLICT"});
    await httpService.remove(scope,"crm",replacement.revision,owner);
    await expect(httpService.prepare(make(),owner)).rejects.toMatchObject({code:"HTTP_SECRET"});
    await artifacts.remove(resource.id,owner);await artifacts.remove(other.id,owner);
  });

  test("context titles expose only currently accessible apps", async () => {
    expect(await artifacts.describe([id, "invalid"], owner.user.id)).toEqual([{ id, title: "Analysis", description: "", icon: "ti ti-app-window",kind:"app",revision:1,publishedVersion:null }]);
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
  test("only admins see unpublished drafts; users can use a published version", async () => {
    await expect(artifacts.get(id,reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await artifacts.list(reader)).items).toHaveLength(0);
    expect(await artifacts.describe([id], reader.user.id)).toEqual([]);
    await artifacts.publish(id, 1, owner, "Test publication");
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
    },owner)));
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await artifacts.get(id,reader,1)).source).toEqual(source);
    expect((await artifacts.get(id,reader)).revision).toBe(1);
    expect((await artifacts.get(id,reader)).title).toBe("Analysis");
    await expect(artifacts.get(id,reader,2)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(artifacts.history(id,reader)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect((await artifacts.history(id,owner)).items.map((item) => item.revision)).toEqual([2,1]);
  });

  test("forks copy the publication into an independent private draft", async () => {
    const copy = await artifacts.fork(id, reader);
    expect(copy.source).toEqual(source);
    expect(copy.publishedRevision).toBeNull();
    expect(copy.forkedFromId).toBe(id);
    expect(copy.forkedFromRevision).toBe(1);
    expect(copy.permission).toBe("admin");
    await expect(artifacts.get(copy.id,owner)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(artifacts.publish(id, 1, owner, "Test publication")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(artifacts.publish(id, 2, reader, "Test publication")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  test("nested Cloud groups receive use grants and unpublishing removes user visibility", async () => {
    const parent = crypto.randomUUID(), child = crypto.randomUUID();
    await sql`INSERT INTO auth.groups(id,name,provider) VALUES(${parent}::uuid,'Parent','local'),(${child}::uuid,'Child','local')`;
    await sql`INSERT INTO auth.group_groups_v2 VALUES(${parent}::uuid,${child}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${stranger.user.id}::uuid,${child}::uuid)`;
    const [grant] = await sql<{id: string}[]>`INSERT INTO auth.access(group_id,permission) VALUES(${parent}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO assistant.artifact_access VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${id}),${grant!.id}::uuid)`;
    expect((await artifacts.get(id,stranger)).sourceRevision).toBe(1);
    expect((await artifacts.list(stranger)).items.map(a => a.id)).toContain(id);
    await artifacts.unpublish(id,owner);
    await expect(artifacts.get(id,stranger)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await artifacts.list(stranger)).items).toHaveLength(0);
    await artifacts.publish(id, 2, owner, "Test publication");
    expect((await artifacts.get(id,stranger)).sourceRevision).toBe(2);
    await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
  });

  test("an unrelated chat lifecycle cannot cascade artifact deletion", async () => {
    const constraints = await sql<{ target: string }[]>`SELECT confrelid::regclass::text AS target
      FROM pg_constraint WHERE conrelid='assistant.artifacts'::regclass AND contype='f'`;
    expect(constraints).toHaveLength(0);
    expect((await artifacts.get(id,owner)).id).toBe(id);
  });

  test("the final manager cannot be removed and foreign grants cannot be changed", async () => {
    const [grant] = await sql<{ access_id: string }[]>`SELECT link.access_id FROM assistant.artifact_access link
      JOIN auth.access a ON a.id=link.access_id WHERE link.artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${id}) AND a.permission='admin'`;
    await expect(artifacts.changeGrant(id,grant!.access_id,null,owner)).rejects.toMatchObject({ code: "LAST_MANAGER" });
    await expect(artifacts.changeGrant(id,crypto.randomUUID(),null,owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("the permission editor uses canonical grants and resolved names", async () => {
    const app = await artifacts.create({ title: "Sharing", source }, owner);
    const grant = await artifacts.grant(app.id, { type: "user", userId: reader.user.id }, "read", owner);
    expect(grant?.principal).toEqual({ type: "user", userId: reader.user.id });
    expect((await artifacts.access(app.id, owner)).map(a => a.displayName)).toEqual(["Test", "Test"]);
    await artifacts.changeGrant(app.id, grant!.id, "admin", owner);
    expect((await artifacts.get(app.id, reader)).permission).toBe("admin");
    await artifacts.changeGrant(app.id, grant!.id, null, owner);
    await expect(artifacts.get(app.id, reader)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  test("agent file writes persist incomplete code, preserve helpers and enforce permissions", async () => {
    const context = { ...owner, locale: "en", requestId: crypto.randomUUID(), origin: "assistant" as const, signal: new AbortController().signal };
    const created = await artifactCodeHandlers.code_create({ kind: "app", title: "Agent test" }, context);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.data.id;
    const write = async (path: string, content: string) => artifactCodeHandlers.code_write({ id, expectedRevision: (await artifacts.get(id, owner)).revision, files: [{ path, content }] }, context);
    const intermediate = await write("main.ts", 'import {value} from "./helper.ts"; export default () => value;');
    expect(intermediate).toMatchObject({ ok: true, data: { data: { saved: true } } });
    if (!intermediate.ok) throw new Error("Write failed");
    expect(intermediate.data.data.diagnostics.length).toBeGreaterThan(0);
    expect(await write("helper.ts", "export const value = 42;"))
      .toMatchObject({ ok: true, data: { data: { saved: true, diagnostics: [] } } });
    expect((await artifacts.get(id, owner)).source.files).toHaveLength(2);
    const expectedRevision = (await artifacts.get(id, owner)).revision;
    const batch = await artifactCodeHandlers.code_write({ id, expectedRevision, files: [{ path: "a.ts", content: "export const a=1;" }, { path: "b.ts", content: "export const b=2;" }] }, context);
    expect(batch).toMatchObject({ ok: true });
    expect((await artifacts.get(id, owner)).revision).toBe(expectedRevision + 1);
    expect(await artifactCodeHandlers.code_write({ id, expectedRevision, files: [{ path: "a.ts", content: "stale" }] }, context)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect((await artifacts.get(id, owner)).source.files).toHaveLength(4);
    await write("main.ts", "export default !!!");
    expect(await artifactCodeHandlers.code_read({ id, path: "main.ts", offset: 0 }, context))
      .toMatchObject({ ok: true, data: { data: { content: "export default !!!", complete: true } } });
    expect(await artifactCodeHandlers.code_write({ id, expectedRevision: 1, files: [{ path: "main.ts", content: "x" }] }, { ...context, ...stranger }))
      .toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
    expect(await artifactCodeHandlers.code_remove({ id, path: "main.ts" }, context))
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
      await expect(clientCalls.claim({ ...first, input: { ...input, id: "Xyz789" } }, owner)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await sql`UPDATE assistant.artifact_client_calls SET result=NULL, created_at=now()-interval '10 minutes' WHERE turn_id=${turnId}::uuid`;
      // Human approval can take longer than the old fixed execution timeout.
      expect(await clientCalls.claim(winner, owner)).toEqual({ status: "pending" });
      expect(await clientCalls.claim(loser, owner)).toEqual({ status: "pending" });
      await clientCalls.complete({ ...winner, result: {late:true} }, owner);
      expect(await clientCalls.claim(loser,owner)).toEqual({status:"done",result:{late:true}});
      await sql`UPDATE assistant.artifact_client_calls SET result=NULL, heartbeat_at=now()-interval '3 minutes' WHERE turn_id=${turnId}::uuid`;
      expect(await clientCalls.claim(loser, owner)).toEqual({ status: "interrupted" });
      expect(await clientCalls.claim(winner, owner)).toEqual({ status: "interrupted" });
      await expect(clientCalls.complete({ ...winner, result: {} }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally { conversation.mockRestore(); turn.mockRestore(); }
  });

  test("source pressure prunes only unpublished history and preserves publications atomically", async () => {
    const app = await artifacts.create({title:"Retention",source},owner);
    await artifacts.publish(app.id,1,owner,"Initial release");
    await artifacts.writeFile(app.id,"main.js","export default () => 2",owner);
    await artifacts.writeFile(app.id,"main.js","export default () => 3",owner);
    await sql`UPDATE assistant.artifact_revisions SET source_bytes=262144000 WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${app.id}) AND revision=2`;
    await artifacts.writeFile(app.id,"main.js","export default () => 4",owner);
    expect((await artifacts.history(app.id,owner)).items.map(item=>item.revision)).toEqual([4,3,1]);
    await sql`UPDATE assistant.artifact_revisions SET source_bytes=262144000 WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${app.id}) AND revision=1`;
    await expect(artifacts.writeFile(app.id,"main.js","export default () => 5",owner)).rejects.toMatchObject({code:"STORAGE_FULL"});
    expect((await artifacts.history(app.id,owner)).items.map(item=>item.revision)).toEqual([4,3,1]);
    expect((await artifacts.get(app.id,owner)).revision).toBe(4);
  });

  test("publication versions preserve metadata, rollback atomically publishes, and sharing is independent", async () => {
    const app = await artifacts.create({title:"Budget",icon:"ti ti-wallet",source},owner);
    await expect(artifacts.publish(app.id,1,owner," ")).rejects.toThrow();
    expect((await artifacts.publish(app.id,1,owner,"Initial calculator")).publishedVersion).toBe(1);
    expect((await artifacts.list(reader)).items.some(item=>item.id===app.id)).toBe(false);
    await artifacts.grant(app.id,{type:"user",userId:reader.user.id},"read",owner);
    const changed=await artifacts.metadata(app.id,{title:"Charts",description:"Chart totals",icon:"ti ti-chart-bar"},owner);
    expect((await artifacts.list(owner,1,undefined,"Chart totals")).items.map(item=>item.id)).toContain(app.id);
    expect((await artifacts.list(reader,1,undefined,"Chart totals")).items.map(item=>item.id)).not.toContain(app.id);
    expect((await artifacts.list(reader,1,undefined,"Budget")).items.map(item=>item.id)).toContain(app.id);
    expect((await artifacts.get(app.id,reader)).icon).toBe("ti ti-wallet");
    const edited=await artifacts.writeFile(app.id,"main.js","export default () => 2",owner);
    await artifacts.publish(app.id,edited.revision,owner,"Add charts");
    expect((await artifacts.get(app.id,reader)).title).toBe("Charts");
    await expect(artifacts.versions(app.id,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.get(app.id,reader,undefined,false,1)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.restore(app.id,1,edited.revision,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.restore(app.id,1,changed.revision,owner)).rejects.toMatchObject({code:"CONFLICT"});
    expect((await artifacts.get(app.id,owner,undefined,false,1)).title).toBe("Budget");
    const restored=await artifacts.restore(app.id,1,edited.revision,owner);
    expect(restored.title).toBe("Budget"); expect(restored.icon).toBe("ti ti-wallet");
    expect(restored.source).toEqual(source);
    expect(restored.publishedVersion).toBe(3);
    expect((await artifacts.get(app.id,reader)).title).toBe("Budget");
    const history=await artifacts.versions(app.id,owner);
    expect(history.items.map(item=>item.version)).toEqual([3,2,1]);
    expect(history.items[0]).toMatchObject({note:"Restore version 1",authorId:owner.user.id});
    await migrateArtifacts();
    expect((await artifacts.versions(app.id,owner)).items).toHaveLength(3);
  });

  test("capability context is correlated to an active owned conversation", async () => {
    const conversationId=crypto.randomUUID(), turnId=crypto.randomUUID(), requestId=crypto.randomUUID();
    await sql`INSERT INTO ai.conversations VALUES(${conversationId}::uuid,${owner.user.id}::uuid,NULL)`;
    await sql`INSERT INTO ai.turns VALUES(${turnId}::uuid,'running')`;
    await sql`INSERT INTO ai.tool_calls VALUES(${requestId},${conversationId}::uuid,${turnId}::uuid,'server')`;
    expect(await aiToolAudit.capabilityConversation(requestId,owner.user.id)).toBe(conversationId);
    expect(await aiToolAudit.capabilityConversation(requestId,stranger.user.id)).toBeNull();
    expect(await aiToolAudit.capabilityConversation(crypto.randomUUID(),owner.user.id)).toBeNull();
    await sql`UPDATE ai.turns SET status='completed' WHERE id=${turnId}::uuid`;
    expect(await aiToolAudit.capabilityConversation(requestId,owner.user.id)).toBeNull();
  });

  test("script capabilities require real approval, remember scopes and never execute twice", async () => {
    const applet=await artifacts.create({title:"Capability app",source},owner);
    const definitions=defineCapabilities({protocolVersion:1,actions:{write:{title:"Write item",description:"Write a test item",input:z.object({value:z.string().describe("Value")}).strict(),data:z.unknown(),approval:"rememberable",idempotency:"required",destructive:false,openWorld:false,
      review:async()=>ok({message:"Write item?",approvalScope:"items:one"}),run:async()=>ok({data:{}})}}});
    const manifest=compileCapabilityManifest("demo",definitions);
    const catalog=spyOn(capabilityClient,"getCapabilityCatalogApp").mockResolvedValue({ok:true,data:{appId:"demo",appName:"Demo",appDescription:"",appIcon:"ti ti-app-window",manifest}});
    const review=spyOn(capabilityClient,"reviewCapabilityAction").mockResolvedValue({ok:true,data:{message:"Write item?",approvalScope:"items:one"}});
    const execute=spyOn(capabilityClient,"invokeCapability").mockResolvedValue({ok:true,data:{data:{written:true}}});
    const caller={cookie:"test-cookie",locale:"en"};
    const request=()=>({id:crypto.randomUUID(),name:"demo.write",input:{value:"one"},artifactId:applet.id});
    try {
      const denied=request();expect(await runtimeCapabilities.prepare(denied,owner,caller)).toMatchObject({status:"approval",allowAlways:true});
      expect(execute).not.toHaveBeenCalled();
      await expect(runtimeCapabilities.resolve(denied.id,{approved:true},stranger,caller)).rejects.toMatchObject({code:"NOT_FOUND"});
      await expect(runtimeCapabilities.resolve(denied.id,{approved:false},stranger,caller)).rejects.toMatchObject({code:"NOT_FOUND"});
      const readsBeforeDecline = catalog.mock.calls.length;
      expect(await runtimeCapabilities.resolve(denied.id,{approved:false},owner,caller)).toEqual({status:"denied"});
      expect(catalog.mock.calls.length).toBe(readsBeforeDecline);
      expect(execute).not.toHaveBeenCalled();
      const changed=request();await runtimeCapabilities.prepare(changed,owner,caller);
      review.mockResolvedValueOnce({ok:true,data:{message:"A different consequence",approvalScope:"items:other"}});
      await expect(runtimeCapabilities.resolve(changed.id,{approved:true},owner,caller)).rejects.toMatchObject({code:"CONFLICT"});
      expect(execute).not.toHaveBeenCalled();
      await runtimeCapabilities.resolve(changed.id,{approved:false},owner,caller);
      const approved=request();await runtimeCapabilities.prepare(approved,owner,caller);
      await runtimeCapabilities.resolve(approved.id,{approved:true,remember:"always"},owner,caller);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0]).toMatchObject({idempotencyKey:`code-${approved.id}`,input:{value:"one"}});
      await runtimeCapabilities.resolve(approved.id,{approved:true},owner,caller);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await runtimeCapabilities.prepare(request(),owner,caller)).toMatchObject({status:"completed"});
      expect(execute).toHaveBeenCalledTimes(2);
      await expect(runtimeCapabilities.prepare(request(),stranger,caller)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    } finally {catalog.mockRestore();review.mockRestore();execute.mockRestore();}
  });

  test("shared resources require consent for queries and ignore personal remembered actions",async()=>{
    const resource=await artifacts.create({title:"Shared data app",source},owner);
    await artifacts.publish(resource.id,1,owner,"Initial release");
    await artifacts.grant(resource.id,{type:"user",userId:reader.user.id},"read",owner);
    const input=z.object({}).strict();
    const definitions=defineCapabilities({protocolVersion:1,
      queries:{read:{title:"Read private data",description:"Read test data",input,data:z.unknown(),openWorld:false,run:async()=>ok({data:[]})}},
      actions:{write:{title:"Write private data",description:"Write test data",input,data:z.unknown(),approval:"rememberable",idempotency:"required",destructive:false,openWorld:false,review:async()=>ok({message:"Write?",approvalScope:"private"}),run:async()=>ok({data:{}})}}});
    const manifest=compileCapabilityManifest("consent",definitions);
    const catalog=spyOn(capabilityClient,"getCapabilityCatalogApp").mockResolvedValue({ok:true,data:{appId:"consent",appName:"Consent",appDescription:"",appIcon:"ti ti-app-window",manifest}});
    const review=spyOn(capabilityClient,"reviewCapabilityAction").mockResolvedValue({ok:true,data:{message:"Write?",approvalScope:"private"}});
    const execute=spyOn(capabilityClient,"invokeCapability").mockResolvedValue({ok:true,data:{data:{private:true}}});
    await sql`INSERT INTO ai.tool_approval_preferences(actor_user_id,tool_name,approval_scope) VALUES(${reader.user.id}::uuid,'consent.write','private')`;
    const request=(name:string)=>({id:crypto.randomUUID(),name,input:{},artifactId:resource.id});
    try {
      const read=request("consent.read");
      expect(await runtimeCapabilities.prepare(read,reader,{})).toMatchObject({status:"approval",allowAlways:false,resource:{title:"Shared data app"}});
      expect(execute).not.toHaveBeenCalled();
      await expect(runtimeCapabilities.resolve(read.id,{approved:true,remember:"always"},reader,{})).rejects.toMatchObject({code:"INVALID_INPUT"});
      expect(await runtimeCapabilities.resolve(read.id,{approved:false},reader,{})).toEqual({status:"denied"});
      expect(execute).not.toHaveBeenCalled();
      const write=request("consent.write");
      expect(await runtimeCapabilities.prepare(write,reader,{})).toMatchObject({status:"approval",allowAlways:false});
      expect(execute).not.toHaveBeenCalled();
      expect(await runtimeCapabilities.resolve(write.id,{approved:true},reader,{})).toMatchObject({status:"completed"});
      await runtimeCapabilities.resolve(write.id,{approved:true},reader,{});
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await runtimeCapabilities.prepare(request("consent.write"),reader,{})).toMatchObject({status:"approval"});
      expect(await runtimeCapabilities.prepare(request("consent.read"),owner,{})).toMatchObject({status:"completed"});
    }finally{catalog.mockRestore();review.mockRestore();execute.mockRestore();}
  });

  test("resource managers can delete shared data and queue database cleanup; use access cannot",async()=>{
    const resource=await artifacts.create({title:"Disposable",source},owner);
    await artifacts.publish(resource.id,1,owner,"Initial release");
    await artifacts.grant(resource.id,{type:"user",userId:reader.user.id},"read",owner);
    await artifacts.storage(resource.id,{area:"kv",operation:"write",key:"x",content:"1"},owner);
    await sql`INSERT INTO assistant.artifact_databases VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${resource.id}),'manager_cleanup_test',false)`;
    await expect(artifacts.remove(resource.id,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactAdmin.remove(resource.id,owner)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    expect(await artifacts.remove(resource.id,owner)).toMatchObject({deleted:true,databaseCleanupQueued:true});
    expect(await sql`SELECT 1 FROM assistant.artifact_storage WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${resource.id})`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assistant.artifact_publications WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${resource.id})`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assistant.database_cleanup WHERE namespace='manager_cleanup_test'`).toHaveLength(1);
    await expect(artifacts.get(resource.id,owner)).rejects.toMatchObject({code:"NOT_FOUND"});
  });

  test("databases are lazy, reconnect idempotently and reject writes through SQL", async () => {
    const applet=await artifacts.create({title:"Lazy DB",source},owner);
    let url="", token="", creates=0;
    const settings=spyOn(app.settings,"get").mockImplementation(async key => key === "assistant.rsql_url" ? url : token);
    const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch:async request => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      if (new URL(request.url).pathname === "/v1/namespaces" && request.method === "POST") creates++;
      return Response.json({name:"test",data:[]});
    }});
    try {
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${applet.id})`).toHaveLength(0);
      await expect(artifactDatabase.connect(applet.id,owner)).rejects.toMatchObject({code:"DB_NOT_CONFIGURED"});
      expect(await artifactCodeHandlers.code_sql({id:applet.id,sql:"SELECT title FROM todos",params:[]},{...owner,locale:"en",signal:new AbortController().signal})).toMatchObject({ok:false,error:{code:"DB_NOT_CONFIGURED"}});
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${applet.id})`).toHaveLength(0);
      url=upstream.url.origin;token="test-token";
      await expect(artifactDatabase.connect(applet.id,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      expect(await artifactDatabase.connect(applet.id,owner)).toEqual({connected:true});
      expect(await artifactDatabase.connect(applet.id,owner)).toEqual({connected:true});
      expect(creates).toBe(1);
      const context={...owner,locale:"en",signal:new AbortController().signal};
      expect(await artifactCodeHandlers.code_sql({id:applet.id,sql:"SELECT title FROM todos LIMIT 10",params:[]},context)).toMatchObject({ok:true});
      expect(creates).toBe(1);
      expect(await artifactCodeHandlers.code_sql({id:applet.id,sql:"DELETE FROM todos",params:[]},context)).toMatchObject({ok:false,error:{code:"DB_SQL_UNSUPPORTED"}});
      expect(await artifactCodeHandlers.code_sql({id:applet.id,sql:"SELECT title FROM todos",params:[]},{...context,...stranger})).toMatchObject({ok:false,error:{code:"ACCESS_DENIED"}});
      await expect(artifactDatabase.call(applet.id,{operation:"query",sql:"DELETE FROM todos",params:[]},owner)).rejects.toMatchObject({code:"DB_SQL_UNSUPPORTED"});
      await artifacts.publish(applet.id,1,owner,"Initial release");
      const fork=await artifacts.fork(applet.id,owner);
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${fork.id})`).toHaveLength(0);
    } finally { settings.mockRestore(); await upstream.stop(true); }
  });

  (process.env.RSQL_TEST_URL ? test : test.skip)("real rsql imports and rejoins 2500 rows without duplicating retries", async () => {
    const resource=await artifacts.create({title:"Excel import",kind:"script",source},owner);
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>key==="assistant.rsql_url" ? process.env.RSQL_TEST_URL! : "artifact-test-only");
    try {
      await artifactDatabase.connect(resource.id,owner);
      const call=(input:unknown)=>artifactDatabase.call(resource.id,input,owner);
      await call({operation:"tables.create",name:"ledger_rows",columns:[{name:"import_key",type:"text",unique:true,not_null:true},{name:"payload",type:"text",not_null:true}]});
      const db={query:async(sql:string,params:string[])=>z.object({data:z.array(z.object({import_key:z.string(),payload:z.string()}))}).parse(await call({operation:"query",sql,params})),table:()=>({insert:(rows:unknown)=>call({operation:"rows.insert",table:"ledger_rows",rows})})};
      const rows=Array.from({length:2500},(_,i)=>({import_key:`folder/book.xlsx::Ledger::${i+2}`,payload:JSON.stringify([i,"12.34"])}));
      expect(await importRows(db,rows,async()=>{})).toEqual({inserted:2500,skipped:0});
      expect(await importRows(db,rows,async()=>{})).toEqual({inserted:0,skipped:2500});
      expect(await call({operation:"query",sql:"SELECT count(*) AS total FROM ledger_rows",params:[]})).toMatchObject({data:[{total:2500}]});
      expect(await artifactCodeHandlers.code_sql({id:resource.id,sql:"SELECT count(*) AS total FROM ledger_rows a JOIN ledger_rows b ON a.import_key = b.import_key",params:[]},{...owner,locale:"en",signal:new AbortController().signal})).toMatchObject({ok:true,data:{data:{data:[{total:2500}]}}});
    } finally {settings.mockRestore();}
  });

  test("database connection errors distinguish invalid credentials from an unavailable server", async () => {
    const applet = await artifacts.create({title:"Database errors",source},owner);
    const upstream = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>Response.json({error:"unauthorized"},{status:401})});
    const settings = spyOn(app.settings,"get").mockImplementation(async key => key === "assistant.rsql_url" ? upstream.url.origin : "private-fixture-token");
    try {
      await expect(artifactDatabase.connect(applet.id,owner)).rejects.toMatchObject({code:"DB_AUTH_FAILED",status:502});
      await upstream.stop(true);
      await expect(artifactDatabase.connect(applet.id,owner)).rejects.toMatchObject({code:"DB_UNREACHABLE",status:502});
    } finally { settings.mockRestore(); await upstream.stop(true); }
  });

  test("Studio management preserves runtime access and scopes shared clears",async()=>{
    const resource=await artifacts.create({title:"Manage data",source},owner);
    await artifacts.publish(resource.id,1,owner,"Initial release");
    const [grant]=await sql<{id:string}[]>`INSERT INTO auth.access(user_id,permission) VALUES(${reader.user.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO assistant.artifact_access VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${resource.id}),${grant!.id}::uuid)`;
    await artifacts.storage(resource.id,{area:"kv",operation:"write",key:"counter",content:"2"},reader);
    await artifacts.storage(resource.id,{area:"files",operation:"write",key:"keep.txt",content:"YQ=="},owner);
    await expect(artifacts.clearStorage(resource.id,"all",reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.storage(resource.id,{area:"kv",operation:"list"},reader,true)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactDatabase.connect(resource.id,reader,undefined,true)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    for (const operation of [{operation:"tables.list"}, {operation:"rows.insert",table:"ledger",rows:[{amount:1}]}])
      await expect(artifactDatabase.call(resource.id,operation,reader,undefined,"maintenance")).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactDatabase.status(resource.id,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactDatabase.reset(resource.id,null,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactDatabase.export(resource.id,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactDatabase.call(resource.id,{operation:"tables.list"},reader,undefined,"inspect")).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await artifacts.clearStorage(resource.id,"kv",owner);
    expect(await artifacts.storage(resource.id,{area:"kv",operation:"list"},reader)).toEqual({items:[]});
    expect(await artifacts.storage(resource.id,{area:"files",operation:"read",key:"keep.txt"},reader)).toMatchObject({item:{content:"YQ=="}});
    expect((await artifacts.get(resource.id,owner)).publishedRevision).toBe(1);
  });

  (process.env.RSQL_TEST_URL ? test : test.skip)("Studio database backup and reset preserve source and rotate namespace generations",async()=>{
    const resource=await artifacts.create({title:"Reset lifecycle",source},owner);
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>key==="assistant.rsql_url"?process.env.RSQL_TEST_URL!:"artifact-test-only");
    try{
      expect(await artifactDatabase.status(resource.id,owner)).toMatchObject({configured:true,connected:false});
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${resource.id})`).toHaveLength(0);
      await artifactDatabase.connect(resource.id,owner,undefined,true);
      await artifactDatabase.call(resource.id,{operation:"tables.create",name:"ledger",columns:[{name:"amount",type:"integer"}]},owner);
      await artifactDatabase.call(resource.id,{operation:"rows.insert",table:"ledger",rows:[{amount:1200}]},owner,undefined,"maintenance");
      const backup=await artifactDatabase.export(resource.id,owner);
      const bytes=new Uint8Array(await backup.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0,15))).toBe("SQLite format 3");
      expect(await artifactDatabase.status(resource.id,owner)).toMatchObject({connected:true});
      const [old]=await sql<{namespace:string}[]>`SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${resource.id})`;
      const oldGeneration=(await artifactDatabase.status(resource.id,owner)).generation;
      await Promise.all([artifactDatabase.reset(resource.id,oldGeneration,owner),artifactDatabase.reset(resource.id,oldGeneration,owner)]);
      expect(await artifactDatabase.status(resource.id,owner)).toMatchObject({connected:false});
      expect(await sql`SELECT 1 FROM assistant.database_cleanup WHERE namespace=${old!.namespace}`).toHaveLength(1);
      await artifactDatabase.connect(resource.id,owner,undefined,true);
      const [next]=await sql<{namespace:string}[]>`SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${resource.id})`;
      expect(next!.namespace).not.toBe(old!.namespace);
      await expect(artifactDatabase.reset(resource.id,oldGeneration,owner)).rejects.toMatchObject({code:"CONFLICT"});
      expect(await artifactDatabase.call(resource.id,{operation:"tables.list"},owner)).toEqual([]);
      expect((await artifacts.get(resource.id,owner)).source).toEqual(source);
      // Draining old generations must not remove the new connection.
      for(let i=0;i<10;i++)await artifactDatabase.cleanup();
      expect(await artifactDatabase.status(resource.id,owner)).toMatchObject({connected:true});
    }finally{settings.mockRestore();}
  });

  test("database settings redact credentials and reject changing an in-use server", async () => {
    const administrator={...stranger,actor:{kind:"user" as const,user:{...stranger.user,roles:["admin" as const]}}};
    const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch:request=>{
      expect(request.headers.get("authorization")).toBe("Bearer secret-fixture");
      return Response.json({data:[]});
    }});
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>key==="assistant.rsql_url" ? upstream.url.origin : "secret-fixture");
    const writes=spyOn(app.settings,"set").mockResolvedValue();
    try {
      await expect(artifactDatabase.settings(owner)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      expect(await artifactDatabase.settings(administrator)).toEqual({url:upstream.url.origin,tokenSet:true});
      expect(await artifactDatabase.configure({url:upstream.url.origin},administrator,true)).toEqual({connected:true});
      expect(writes).not.toHaveBeenCalled();
      await expect(artifactDatabase.configure({url:"",token:""},administrator)).rejects.toMatchObject({code:"DB_SERVER_IN_USE"});
      await expect(artifactDatabase.configure({url:"http://different.invalid",token:"new"},administrator)).rejects.toMatchObject({code:"DB_SERVER_IN_USE"});
      expect(writes).not.toHaveBeenCalled();
    } finally {settings.mockRestore();writes.mockRestore();await upstream.stop(true);}
  });

  test("platform administration is explicit and deletion queues database cleanup", async () => {
    const applet=await artifacts.create({title:"Admin cleanup",source},owner);
    await artifacts.storage(applet.id,{area:"kv",operation:"write",key:"x",content:"1"},owner);
    await sql`INSERT INTO assistant.artifact_databases VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${applet.id}),'assistant_cleanup_test',false)`;
    await expect(artifactAdmin.list(stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.get(applet.id,{...stranger,administrative:true})).rejects.toMatchObject({code:"ACCESS_DENIED"});
    const administrator={...stranger,actor:{kind:"user" as const,user:{...stranger.user,roles:["admin" as const]}}};
    expect((await artifactAdmin.list(administrator,1,"Admin cleanup")).items[0]).toMatchObject({kv:1,files:0,database:true});
    expect(await artifacts.access(applet.id,adminIdentity(administrator))).toHaveLength(1);
    // Platform administration does not expose all private apps in Studio.
    expect((await artifacts.list(administrator)).items.map(item=>item.id)).not.toContain(applet.id);
    expect(await artifactAdmin.remove(applet.id,administrator)).toMatchObject({deleted:true,databaseCleanupQueued:true});
    expect(await sql`SELECT 1 FROM assistant.artifact_storage WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${applet.id})`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${applet.id})`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assistant.database_cleanup WHERE namespace='assistant_cleanup_test'`).toHaveLength(1);
  });

  test("shared storage survives publications but is not copied into forks", async () => {
    const app=await artifacts.create({title:"Stored data",source},owner);
    const write={area:"kv",operation:"write",key:"counter",content:"42"};
    await expect(artifacts.storage(app.id,write,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await artifacts.storage(app.id,write,owner);
    await artifacts.publish(app.id,1,owner,"Initial release");
    await artifacts.grant(app.id,{type:"user",userId:reader.user.id},"read",owner);
    expect(await artifacts.storage(app.id,{area:"kv",operation:"read",key:"counter"},reader)).toMatchObject({item:{content:"42"}});
    await artifacts.storage(app.id,{...write,content:"43"},reader);
    await artifacts.storage(app.id,{area:"files",operation:"write",key:"input.csv",content:btoa("a,b\n1,2"),mediaType:"text/csv"},reader);
    const edit=await artifacts.writeFile(app.id,"main.js","export default () => 2",owner);
    await artifacts.publish(app.id,edit.revision,owner,"Changed UI");
    expect(await artifacts.storage(app.id,{area:"kv",operation:"read",key:"counter"},reader)).toMatchObject({item:{content:"43"}});
    const fork=await artifacts.fork(app.id,reader);
    expect(await artifacts.storage(fork.id,{area:"kv",operation:"list"},reader)).toEqual({items:[]});
    expect(await artifacts.storage(fork.id,{area:"files",operation:"list"},reader)).toEqual({items:[]});
    await artifacts.unpublish(app.id,owner);
    await expect(artifacts.storage(app.id,{area:"kv",operation:"read",key:"counter"},reader)).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(artifacts.storage(app.id,{...write,content:"undefined"},owner)).rejects.toMatchObject({code:"INVALID_INPUT"});
  });

  test("project scripts stay contextual and cannot grant edit or fork rights", async () => {
    const projectId = crypto.randomUUID(), conversationId = crypto.randomUUID();
    let member = true, currentProject: string | null = projectId;
    const conversation = spyOn(aiConversations,"getConversation").mockImplementation(async input => ({
      id: conversationId, shortId: "project1", title: "Project", titleSource: "user", description: "", descriptionSource: "user",
      keywords: [], pinnedAt: null, archivedAt: null, runStatus: "idle", runError: null, unreadCompletion: false,
      projectId: currentProject, draft: {content:[],revision:1,updatedAt:null}, createdByUserId: input.ownerUserId ?? null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const project = spyOn(aiProjects,"get").mockImplementation(async (id,subject,permission) =>
      id === projectId && (subject?.type === "user" && subject.userId === owner.user.id || member && permission === "read")
        ? {id,shortId:"project1",name:"Project",description:"",icon:"",instructions:"",defaultModelProfileId:null,
          permission: permission ?? "read",revision:1,createdAt:"",updatedAt:""} : null);
    const shortProject = spyOn(aiProjects,"getByShortId").mockImplementation(async (shortId,subject,permission) =>
      shortId === "project1" ? aiProjects.get(projectId,subject,permission) : null);
    const contextual = {...stranger,conversationId};
    try {
      const script = await artifacts.create({kind:"script",title:"Shared calculation",source},owner);
      expect(script.kind).toBe("script");
      await artifacts.linkProject(script.id,"project1",true,owner);
      expect(await artifacts.projects(script.id,owner)).toEqual([{projectId}]);
      const administrator={...owner,actor:{kind:"user" as const,user:{...owner.user,roles:["admin" as const]}}};
      expect((await artifactAdmin.list(administrator,1,"Shared calculation")).items[0]).toMatchObject({projects:[projectId],published:false,bytes:0});
      await expect(artifacts.get(script.id,contextual)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await artifacts.publish(script.id,1,owner,"Initial release");
      expect((await artifacts.get(script.id,contextual)).permission).toBe("read");
      expect(await artifacts.describe([script.id],stranger.user.id,conversationId)).toHaveLength(1);
      expect(await artifacts.describe([script.id],stranger.user.id)).toEqual([]);
      expect((await artifacts.list(contextual,1,"script")).items.map(item=>item.id)).toContain(script.id);
      expect((await artifacts.list(stranger,1,"script")).items.map(item=>item.id)).not.toContain(script.id);
      expect((await artifacts.list(contextual,1,"app")).items.map(item=>item.id)).not.toContain(script.id);
      const toolContext = {...contextual, locale: "en", signal: new AbortController().signal};
      expect(await artifactCodeHandlers.code_read({id:script.id,path:"main.js",offset:0},toolContext))
        .toMatchObject({ok:true,data:{data:{content:source.files[0]!.content}}});
      expect(await artifactCodeHandlers.code_read({id:script.id,path:"main.js",offset:0},{...stranger,locale:"en",signal:toolContext.signal}))
        .toMatchObject({ok:false,error:{code:"ACCESS_DENIED"}});
      await expect(artifacts.fork(script.id,contextual)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.writeFile(script.id,"main.js","export default () => 2",contextual)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      currentProject = crypto.randomUUID();
      await expect(artifacts.get(script.id,contextual)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      currentProject = projectId; member = false;
      await expect(artifacts.get(script.id,contextual)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      expect(await artifacts.describe([script.id],stranger.user.id,conversationId)).toEqual([]);
      member = true;
      await artifacts.linkProject(script.id,projectId,false,owner);
      await expect(artifacts.get(script.id,contextual)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await artifacts.grant(script.id,{type:"user",userId:stranger.user.id},"read",owner);
      expect((await artifacts.get(script.id,stranger)).kind).toBe("script");
      expect((await artifacts.fork(script.id,stranger)).kind).toBe("script");
    } finally { conversation.mockRestore(); project.mockRestore(); shortProject.mockRestore(); }
  });

  test("edit creates an unsent chat draft and indexes the app reference for admins only", async () => {
    const conversationId = crypto.randomUUID();
    const create = spyOn(aiConversations, "createConversation").mockImplementation(async input => ({
      id: conversationId, shortId: "edit01", title: input.title!, titleSource: "user", description: "", descriptionSource: "user",
      keywords: [], pinnedAt: null, archivedAt: null, runStatus: "idle", runError: null, unreadCompletion: false,
      projectId: null, draft: { content: input.draft ?? [], revision: 1, updatedAt: null }, createdByUserId: input.ownerUserId ?? null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const index = spyOn(aiConversations, "indexConversationResources").mockResolvedValue();
    try {
      await expect(artifacts.editChat(id, reader)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(create).not.toHaveBeenCalled();
      const result = await artifacts.editChat(id, owner);
      expect(result.href).toContain("conversation=edit01");
      expect(create.mock.calls[0]![0].draft).toEqual([expect.objectContaining({ type: "resource", ref: { type: "assistant.artifact", id } })]);
      expect(index.mock.calls[0]![0]).toMatchObject({ conversationId, resources: [{ ref: { type: "assistant.artifact", id } }] });
    } finally { create.mockRestore(); index.mockRestore(); }
  });
  test.skipIf(!process.env.ASSISTANT_EVAL_URL)("real model builds and exercises the three-CSV dashboard", async () => {
    const conversationId=crypto.randomUUID(),turnId=crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversationId}::uuid,${owner.user.id}::uuid)`;
    await sql`INSERT INTO ai.turns(id,status) VALUES(${turnId}::uuid,'running')`;
    const conversation=spyOn(aiConversations,"getConversation").mockImplementation(async request=>request.ownerUserId !== owner.user.id ? null : ({
      id:conversationId,shortId:"abc234",title:"Host test",titleSource:"user",description:"",descriptionSource:"user",keywords:[],pinnedAt:null,archivedAt:null,
      runStatus:"running",runError:null,unreadCompletion:false,projectId:null,draft:{content:[],revision:1,updatedAt:null},createdByUserId:owner.user.id,
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    }));
    const turn=spyOn(aiConversations,"getActiveTurn").mockResolvedValue({turn:{id:turnId,shortId:"abc345",conversationId,status:"running",attempt:1,modelProfileId:null,
      createdAt:new Date().toISOString(),completedAt:null,error:null},liveBlocks:[],liveSeq:1});
    try {
      const result=await evaluateCodeMode({...owner,conversationId,locale:"de",signal:AbortSignal.timeout(1_200_000)},turnId);
      expect(result.apps).toHaveLength(1);
      const app=result.apps[0]!;
      const runs=result.history.filter(entry=>entry.message.role==="tool_result").map(entry=>entry.message.role==="tool_result"?entry.message.result:null);
      expect(runs).toContainEqual(expect.objectContaining({id:app.id,revision:app.revision,status:"ready"}));
      expect(result.history.filter(entry=>entry.message.role==="tool_result"&&entry.message.name==="code_interact").length).toBeGreaterThanOrEqual(3);
    } finally {await agentHost.close();conversation.mockRestore();turn.mockRestore();}
  },1_230_000);
  test("server-owned code survives caller detachment, deduplicates calls and never replays a lost host", async () => {
    const conversationId=crypto.randomUUID(),turnId=crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversationId}::uuid,${owner.user.id}::uuid)`;
    await sql`INSERT INTO ai.turns(id,status) VALUES(${turnId}::uuid,'running')`;
    const conversation=spyOn(aiConversations,"getConversation").mockImplementation(async request=>request.ownerUserId !== owner.user.id ? null : ({
      id:conversationId,shortId:"abc234",title:"Host test",titleSource:"user",description:"",descriptionSource:"user",keywords:[],pinnedAt:null,archivedAt:null,
      runStatus:"running",runError:null,unreadCompletion:false,projectId:null,draft:{content:[],revision:1,updatedAt:null},createdByUserId:owner.user.id,
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    }));
    const turn=spyOn(aiConversations,"getActiveTurn").mockResolvedValue({turn:{id:turnId,shortId:"abc345",conversationId,status:"running",attempt:1,modelProfileId:null,
      createdAt:new Date().toISOString(),completedAt:null,error:null},liveBlocks:[],liveSeq:1});
    const abort=new AbortController();
    const context={...owner,conversationId,locale:"en",signal:abort.signal};
    const call={turnId,callId:"server-run",name:"code_run" as const,args:{code:"export default () => ({answer:42,serverProcess:typeof process})"}};
    const wait=async(input:Parameters<typeof agentHost.call>[0])=>{
      for(let i=0;i<200;i++) {const result=await agentHost.call(input,{...context,signal:new AbortController().signal});if(result.status!=="running"&&result.status!=="busy")return result;await Bun.sleep(25);}
      throw new Error("Managed host test did not finish");
    };
    try {
      const starts=await Promise.all([agentHost.call(call,context),agentHost.call(call,context)]);
      expect(starts.every(result=>["running","busy"].includes(result.status))).toBe(true);
      abort.abort(); // Detaching the HTTP caller must not terminate the owned execution.
      const observers=await Promise.all(Array.from({length:8},()=>wait(call)));
      expect(observers.every(result=>result.status==="done")).toBe(true);
      const result=observers[0]!;
      expect(result).toMatchObject({status:"done",result:{status:"ready",output:'{"answer":42,"serverProcess":"undefined"}'}});
      expect(await wait(call)).toEqual(result);
      const [count]=await sql<{count:number}[]>`SELECT count(*)::int AS count FROM assistant.artifact_agent_calls WHERE turn_id=${turnId}::uuid`;
      expect(count!.count).toBe(1);
      const syntax = await wait({...call,callId:"syntax-error",args:{code:"export default () => { const broken = ; }"}});
      expect(syntax).toMatchObject({status:"done",result:{error:expect.stringContaining("Unexpected")}});
      expect(JSON.stringify(syntax)).not.toContain("artifact request failed");
      await expect(agentHost.call({...call,args:{code:"export default ()=>43"}},context)).rejects.toThrow("input changed");
      await expect(agentHost.call(call,{...context,...stranger})).rejects.toThrow();
      const inspect={...call,name:"code_inspect" as const,callId:"server-inspect",args:{runId:call.callId}};
      expect(await wait(inspect)).toMatchObject({status:"done",result:{runId:call.callId,status:"ready"}});
      const generated=Array.from({length:1000},(_,index)=>({index,amount:"123456789.123400",region:"Süd"}));
      const produce={...call,callId:"produce-data",args:{code:`export default async()=>{await files.save(JSON.stringify(${JSON.stringify(generated)}),"data.json");return "saved";}`}};
      expect(await wait(produce)).toMatchObject({status:"done",result:{status:"ready"}});
      const exported=await wait({...call,name:"code_export",callId:"export-data",args:{runId:produce.callId,name:"data.json"}});
      const file=z.object({path:z.string(),version:z.number()}).parse("result" in exported ? exported.result : null);
      const resource=await artifacts.create({title:"Imported data",source},owner);
      const written=await artifactCodeHandlers.code_write({id:resource.id,expectedRevision:1,entry:"main.ts",files:[
        {path:"data.json",fromChatFile:file},{path:"main.ts",content:'import data from "./data.json"; export default()=>({rows:data.length,first:data[0],last:data.at(-1)});'},
      ]},context);
      expect(written.ok).toBe(true);
      expect((await artifacts.get(resource.id,owner)).source.files.find(file=>file.path==="data.json")?.content).toBe(JSON.stringify(generated));
      expect(await wait({...call,callId:"run-import",args:{id:resource.id}})).toMatchObject({status:"done",result:{status:"ready",id:resource.id,revision:2,output:JSON.stringify({rows:1000,first:generated[0],last:generated.at(-1)})}});
      const stale=await artifactCodeHandlers.code_write({id:resource.id,expectedRevision:2,files:[{path:"data.json",fromChatFile:{...file,version:2}}]},context);
      expect(stale.ok).toBe(false);
      expect((await artifacts.get(resource.id,owner)).revision).toBe(2);
      const lookup=spyOn(aiConversations,"getConversationByShortId").mockImplementation(async request=>aiConversations.getConversation({conversationId,ownerUserId:request.ownerUserId}));
      const sources=spyOn(aiConversations,"listConversationSources").mockResolvedValue({sources:[{kind:"resource",key:resource.id,title:"Old title",preview:null,icon:"ti ti-code",href:null,path:null,mediaType:null,size:null,ref:{type:"assistant.artifact",id:resource.id},occurrences:1,firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),sourceTurnId:turnId,sourceCallId:"run-import"}],nextCursor:undefined});
      const tasks=spyOn(aiChatTasks,"list").mockResolvedValue([]);
      try {
        const snapshot=await loadAssistantChatContextSnapshot(owner.user.id,"abc234","de");
        expect(snapshot?.sources[0]?.preview).toContain("R2 · Entwurf · Lauf erfolgreich");
        expect(snapshot?.runs.some(run=>run.id===call.callId&&run.status==="ready")).toBe(true);
        await artifacts.writeFile(resource.id,"main.ts","export default()=>43",owner);
        expect((await loadAssistantChatContextSnapshot(owner.user.id,"abc234","de"))?.sources[0]?.preview).toContain("R3 · Entwurf · Revision noch nicht ausgeführt");
        expect(await loadAssistantChatContextSnapshot(stranger.user.id,"abc234","de")).toBeNull();
      } finally {lookup.mockRestore();sources.mockRestore();tasks.mockRestore();}
      let sent=0;
      const http=spyOn(httpService,"execute").mockImplementation(async(_id,approved)=>{expect(approved).toBe(true);sent++;return {status:200,headers:{"content-type":"application/json"},body:btoa('{"ok":true}')};});
      try {
        const network={...call,callId:"approved-http",args:{code:'export default async()=>await (await http.fetch("https://example.com/data")).json()'}};
        let approval:{id:string}|undefined;
        for(let i=0;i<200&&!approval;i++){const state=await agentHost.call(network,context);approval=state.approvals[0];if(!approval)await Bun.sleep(25);}
        expect(approval).toBeDefined();expect(sent).toBe(0);
        await agentHost.call({...network,decision:{id:approval!.id,approved:true}},context);
        expect(await wait(network)).toMatchObject({status:"done",result:{output:'{"ok":true}'}});
        expect(await wait(network)).toMatchObject({status:"done"});expect(sent).toBe(1);
      } finally {http.mockRestore();}
      await agentHost.sweep(); // Includes a browser event-loop heartbeat.
      await agentHost.close();
      await sql`UPDATE assistant.artifact_agent_calls SET status='running' WHERE turn_id=${turnId}::uuid AND call_id=${call.callId}`;
      expect(await wait(call)).toMatchObject({status:"lost"});
    } finally {await agentHost.close();conversation.mockRestore();turn.mockRestore();}
  },30000);

  test("resources expose only Cloud short IDs and migration preserves resource-scoped secrets", async () => {
    const resource = await artifacts.create({kind:"app",title:"Short ID",source},owner);
    expect(resource.id).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/);
    const [internal] = await sql<{id:string}[]>`SELECT id FROM assistant.artifacts WHERE short_id=${resource.id}`;
    await expect(artifacts.get(internal!.id, owner)).rejects.toThrow();
    await httpService.save({resourceId:resource.id}, {name:"migrate",origin:"https://example.com",header:"Authorization",prefix:"Bearer ",value:"test-only",expectedRevision:null},owner);
    await sql`UPDATE assistant.http_secrets SET scope=${"resource:"+internal!.id} WHERE resource_id=${internal!.id}::uuid`;
    await migrateArtifacts();
    expect(await httpService.list({resourceId:resource.id},owner)).toHaveLength(1);
    expect((await artifacts.get(resource.id,owner)).id).toBe(resource.id);
  });


});
