import {importRows} from "../../examples/accounting/import-rows";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities } from "@k2b/cloud/contracts";
import { z } from "zod";
import { ok } from "@k2b/stdlib";
import { runtimeCapabilities } from "./capability-runtime";
import { beforeAll, afterAll, describe, expect, test, spyOn } from "bun:test";
import { aiConversations, aiProjects, aiToolAudit } from "@k2b/cloud/ai";
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
    await sql`CREATE TABLE ai.tool_calls(request_id text,conversation_id uuid,turn_id uuid,location text)`;
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
      await sql`INSERT INTO assistant.artifact_access VALUES(${id}::uuid,${grant!.id}::uuid)`;
    }
  });
  afterAll(async () => { await sql.close(); });

  test("context titles expose only currently accessible apps", async () => {
    expect(await artifacts.describe([id, "invalid"], owner.user.id)).toEqual([{ id, title: "Analysis", description: "", icon: "ti ti-app-window" }]);
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
    await sql`INSERT INTO assistant.artifact_access VALUES(${id}::uuid,${grant!.id}::uuid)`;
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
      JOIN auth.access a ON a.id=link.access_id WHERE link.artifact_id=${id}::uuid AND a.permission='admin'`;
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
    const write = (path: string, content: string) => artifactCodeHandlers.code_write({ id, path, content }, context);
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
    expect(await artifactCodeHandlers.code_read({ id, path: "main.ts", offset: 0 }, context))
      .toMatchObject({ ok: true, data: { data: { content: "export default !!!", complete: true } } });
    expect(await artifactCodeHandlers.code_write({ id, path: "main.ts", content: "x" }, { ...context, ...stranger }))
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
      await expect(clientCalls.claim({ ...first, input: { ...input, id: crypto.randomUUID() } }, owner)).rejects.toMatchObject({ code: "INVALID_INPUT" });
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
    await sql`UPDATE assistant.artifact_revisions SET source_bytes=262144000 WHERE artifact_id=${app.id}::uuid AND revision=2`;
    await artifacts.writeFile(app.id,"main.js","export default () => 4",owner);
    expect((await artifacts.history(app.id,owner)).items.map(item=>item.revision)).toEqual([4,3,1]);
    await sql`UPDATE assistant.artifact_revisions SET source_bytes=262144000 WHERE artifact_id=${app.id}::uuid AND revision=1`;
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
    await sql`INSERT INTO assistant.artifact_databases VALUES(${resource.id}::uuid,'manager_cleanup_test',false)`;
    await expect(artifacts.remove(resource.id,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactAdmin.remove(resource.id,owner)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    expect(await artifacts.remove(resource.id,owner)).toMatchObject({deleted:true,databaseCleanupQueued:true});
    expect(await sql`SELECT 1 FROM assistant.artifact_storage WHERE artifact_id=${resource.id}::uuid`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assistant.artifact_publications WHERE artifact_id=${resource.id}::uuid`).toHaveLength(0);
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
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=${applet.id}::uuid`).toHaveLength(0);
      await expect(artifactDatabase.connect(applet.id,owner)).rejects.toMatchObject({code:"DB_NOT_CONFIGURED"});
      expect(await artifactCodeHandlers.code_sql({id:applet.id,sql:"SELECT title FROM todos",params:[]},{...owner,locale:"en",signal:new AbortController().signal})).toMatchObject({ok:false,error:{code:"DB_NOT_CONFIGURED"}});
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=${applet.id}::uuid`).toHaveLength(0);
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
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=${fork.id}::uuid`).toHaveLength(0);
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
    await sql`INSERT INTO assistant.artifact_databases VALUES(${applet.id}::uuid,'assistant_cleanup_test',false)`;
    await expect(artifactAdmin.list(stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.get(applet.id,{...stranger,administrative:true})).rejects.toMatchObject({code:"ACCESS_DENIED"});
    const administrator={...stranger,actor:{kind:"user" as const,user:{...stranger.user,roles:["admin" as const]}}};
    expect((await artifactAdmin.list(administrator,1,"Admin cleanup")).items[0]).toMatchObject({kv:1,files:0,database:true});
    expect(await artifacts.access(applet.id,adminIdentity(administrator))).toHaveLength(1);
    // Platform administration does not expose all private apps in Studio.
    expect((await artifacts.list(administrator)).items.map(item=>item.id)).not.toContain(applet.id);
    expect(await artifactAdmin.remove(applet.id,administrator)).toMatchObject({deleted:true,databaseCleanupQueued:true});
    expect(await sql`SELECT 1 FROM assistant.artifact_storage WHERE artifact_id=${applet.id}::uuid`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=${applet.id}::uuid`).toHaveLength(0);
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
});
