import { readdir } from "node:fs/promises";
import { studioFiles } from "./file-transfer";
import { Hono } from "hono";
import { accessRevision, type AuthContext } from "@k2b/cloud/server";
import { createArtifactServiceRoutes } from "./api";
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
    await sql`CREATE SCHEMA settings`;
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text,updated_at timestamptz DEFAULT now())`;
    await sql`CREATE SCHEMA ai`;
    await sql`CREATE TABLE ai.conversations(id uuid PRIMARY KEY,created_by_user_id uuid,archived_at timestamptz)`;
    await sql`CREATE TABLE ai.projects(id uuid PRIMARY KEY,short_id text UNIQUE,name text,description text DEFAULT '',icon text DEFAULT '',instructions text DEFAULT '',default_model_profile_id text,revision integer DEFAULT 1,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`;
    await sql`CREATE TABLE ai.project_access(project_id uuid,access_id uuid)`;
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

  test("public runner exposes only the publication and never grants server or management access", async () => {
    const resource = await artifacts.create({title:"Published name",source},owner);
    const publicGrant = await artifacts.grant(resource.id,{type:"public"},"read",owner);
    expect(publicGrant?.principal.type).toBe("public");
    await expect(artifacts.runner(resource.id,{})).rejects.toMatchObject({code:"NOT_FOUND"});
    await artifacts.publish(resource.id,1,owner,"Initial release");
    await artifacts.metadata(resource.id,{title:"Secret draft name"},owner);
    await artifacts.writeFile(resource.id,"main.js","export default () => 'unpublished secret'",owner);
    const anonymous = await artifacts.runner(resource.id,{});
    expect(anonymous).toMatchObject({title:"Published name",sourceRevision:1,serverAccess:false,canManage:false});
    expect(JSON.stringify(anonymous)).not.toContain("unpublished secret");
    expect(await artifacts.runner(resource.id,stranger)).toMatchObject({serverAccess:false,canManage:false});
    expect(await artifacts.runner(resource.id,owner)).toMatchObject({title:"Published name",sourceRevision:1,serverAccess:true,canManage:true});
    await expect(artifacts.get(resource.id,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.storage(resource.id,{area:"kv",operation:"read",key:"secret"},stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifactDatabase.status(resource.id,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await expect(artifacts.grant(resource.id,{type:"public"},"admin",owner)).rejects.toMatchObject({code:"PUBLIC_READ_ONLY"});
    await expect(artifacts.changeGrant(resource.id,publicGrant!.id,"admin",owner)).rejects.toMatchObject({code:"PUBLIC_READ_ONLY"});
    const grants = await artifacts.access(resource.id,owner);
    expect(await artifactCodeHandlers.code_access_change({id:resource.id,accessId:publicGrant!.id,permission:"admin",expectedAccessRevision:accessRevision(grants)},
      {...owner,locale:"en",signal:new AbortController().signal,review:true})).toMatchObject({ok:false,error:{code:"PUBLIC_READ_ONLY"}});
    await artifacts.grant(resource.id,{type:"user",userId:reader.user.id},"read",owner);
    expect(await artifacts.runner(resource.id,reader)).toMatchObject({serverAccess:true,canManage:false});
    const {createRunnerRoutes} = await import("./runner-api");
    const api = createRunnerRoutes();
    const meta = await api.request(`/${resource.id}`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({serverAccess:false,title:"Published name"});
    const compiled = await api.request(`/${resource.id}/compiled?revision=2`);
    expect(compiled.status).toBe(200);
    const output = await compiled.json();
    expect(output.metadata.sourceRevision).toBe(1);
    expect(output.code).not.toContain("unpublished secret");
    expect(output.metadata.source).toBeUndefined();
    expect((await api.request(`/${resource.id}/storage`,{method:"POST"})).status).toBe(404);
    expect((await api.request(`/${resource.id}/access`)).status).toBe(404);
    await artifacts.unpublish(resource.id,owner);
    expect((await api.request(`/${resource.id}`)).status).toBe(404);
    await artifacts.publish(resource.id,(await artifacts.get(resource.id,owner)).revision,owner,"Second publication");
    await artifacts.changeGrant(resource.id,publicGrant!.id,null,owner);
    expect((await api.request(`/${resource.id}/compiled`)).status).toBe(404);
    expect(await artifacts.runner(resource.id,reader)).toMatchObject({serverAccess:true});
    await artifacts.remove(resource.id,owner);
  });

  test("published actions are discoverable with Use, validate inputs and reject stale releases", async () => {
    const action = { name: "double", title: "Double", description: "Double a number", entry: "double.ts",
      inputSchema: { type: "number" }, outputSchema: { type: "number" } };
    const resource = await artifacts.create({ title: "Headless", source: { entry: "main.ts", files: [
      { path: "app.actions.json", content: JSON.stringify({ actions: [action] }) },
      { path: "double.ts", content: "export default (value: number) => value * 2;" },
    ] } }, owner);
    await artifacts.grant(resource.id, { type: "user", userId: reader.user.id }, "read", owner);
    const api = new Hono<AuthContext>().use("*", async (c, next) => {
      c.set("actor", reader.actor); c.set("accessSubject", reader.accessSubject); await next();
    }).route("/", createArtifactServiceRoutes());
    const call = (input: unknown, publishedVersion = 1) => api.request("/runtime/action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: resource.id, action: "double", publishedVersion, input }),
    });
    try {
      expect((await api.request(`/${resource.id}/actions`)).status).toBe(404);
      await artifacts.publish(resource.id, 1, owner, "Initial actions");
      expect(await (await api.request(`/${resource.id}/actions`)).json()).toMatchObject({ publishedVersion: 1, actions: [action] });
      expect((await api.request(`/${resource.id}/actions?draft=true`)).status).toBe(403);
      expect((await api.request("/runtime/action", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: resource.id, action: "double", revision: 1, input: 3 }) })).status).toBe(403);
      expect((await call("wrong type")).status).toBe(400);
      expect((await call(3)).status).toBe(200);
      await artifacts.writeFile(resource.id, "double.ts", "export default (value: number) => value * 3;", owner);
      const context = { ...owner, locale:"en", signal:new AbortController().signal };
      expect(await artifactCodeHandlers.code_actions({id:resource.id,draft:false},context)).toMatchObject({ok:true,data:{data:{publishedVersion:1}}});
      expect(JSON.stringify(await artifactCodeHandlers.code_actions({id:resource.id,draft:false},context))).not.toContain('"revision"');
      expect(await artifactCodeHandlers.code_actions({id:resource.id,draft:true},context)).toMatchObject({ok:true,data:{data:{revision:2}}});
      // A draft update does not change the published action.
      expect((await call(3)).status).toBe(200);
      await artifacts.publish(resource.id, 2, owner, "Triple now");
      expect((await call(3)).status).toBe(409);
      expect((await call(3, 2)).status).toBe(200);
      await artifacts.unpublish(resource.id, owner);
      expect((await call(3, 2)).status).toBe(404);
    } finally { await artifacts.remove(resource.id, owner); }
  });

  test("agent publication and draft discovery report invalid source without changing publication", async () => {
    const context = { ...owner, locale: "en", signal: new AbortController().signal };
    for (const content of ["{", JSON.stringify({actions:[{name:"Convert"}]}), JSON.stringify({actions:[{name:"convert",title:"Convert",description:"Convert",entry:"missing.ts",inputSchema:{},outputSchema:{}}]})]) {
      const resource = await artifacts.create({ title: "Invalid manifest", source: { entry:"main.ts", files:[...source.files,{path:"app.actions.json",content}] } }, owner);
      try {
        expect(await artifactCodeHandlers.code_actions({id:resource.id,draft:true},context)).toMatchObject({ok:false,error:{code:"COMPILE_FAILED",status:400,message:expect.stringContaining("app.actions.json")}});
        expect(await artifactCodeHandlers.code_publish({id:resource.id,expectedRevision:1,note:"Test"},context)).toMatchObject({ok:false,error:{code:"COMPILE_FAILED",status:400}});
        expect((await artifacts.get(resource.id,owner)).publishedVersion).toBeNull();
      } finally { await artifacts.remove(resource.id,owner); }
    }
  });

  test("saved script migration preserves revisions, grants and project associations", async () => {
    const resource = await artifacts.create({ title: "Legacy reusable code", source }, owner);
    await artifacts.publish(resource.id, 1, owner, "Legacy publication");
    await artifacts.grant(resource.id, { type: "user", userId: reader.user.id }, "read", owner);
    const projectId = crypto.randomUUID();
    await sql`ALTER TABLE assistant.artifacts DROP CONSTRAINT artifacts_kind_check`.simple();
    await sql`UPDATE assistant.artifacts SET kind='script' WHERE short_id=${resource.id}`;
    await sql`INSERT INTO assistant.artifact_projects SELECT id,${projectId}::uuid FROM assistant.artifacts WHERE short_id=${resource.id}`;
    await migrateArtifacts();
    expect(await artifacts.get(resource.id, reader)).toMatchObject({ kind: "app", source, publishedVersion: 1 });
    expect(await artifacts.projects(resource.id, owner)).toEqual([{ projectId, shortId: null, name: null }]);
    await expect(artifacts.create({ kind: "script", title: "Rejected legacy kind", source }, owner)).rejects.toThrow();
    await artifacts.remove(resource.id, owner);
  });

  test("shared binary files have independent atomic byte budgets, pagination and no count ceiling",async()=>{
    let total=1, single=1;
    let cleanup="";
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>({"assistant.storage_total_mib":total,"assistant.storage_file_mib":single,"assistant.rsql_url":"","assistant.rsql_api_token":""}[key]));
    try {
      const resource=await artifacts.create({title:"Binary storage",source},owner);
      cleanup=resource.id;
      await artifacts.publish(resource.id,1,owner,"Storage fixture");
      await artifacts.grant(resource.id,{type:"user",userId:reader.user.id},"read",owner);
      const write=(key:string,data:Uint8Array)=>artifacts.storage(resource.id,{area:"files",operation:"write",key},reader,false,data);
      await sql`INSERT INTO assistant.artifact_storage(artifact_id,area,key,content,data,bytes)
        SELECT (SELECT id FROM assistant.artifacts WHERE short_id=${resource.id}),'files',lpad(n::text,5,'0'),'',''::bytea,0 FROM generate_series(1,1001) AS n`;
      await write("binary",new Uint8Array([0,128,255]));
      const read=await artifacts.storage(resource.id,{area:"files",operation:"read",key:"binary"},reader);
      expect("item" in read && [...read.item!.data!]).toEqual([0,128,255]);
      const first=await artifacts.storage(resource.id,{area:"files",operation:"list",limit:1000},reader);
      expect("items" in first && first.items?.length).toBe(1000);
      const rest=await artifacts.storage(resource.id,{area:"files",operation:"list",after:"01000"},reader);
      expect("items" in rest && rest.items?.length).toBe(2);
      await expect(artifacts.storage(resource.id,{area:"files",operation:"read",key:"binary"},stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.storage(resource.id,{area:"files",operation:"read",key:"binary"},reader,true)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      const results=await Promise.allSettled([write("large-a",new Uint8Array(600000)),write("large-b",new Uint8Array(600000))]);
      expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
      expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
      const api=new Hono<AuthContext>().use("*",async(c,next)=>{
        c.set("actor",reader.actor);c.set("accessSubject",reader.accessSubject);await next();
      }).route("/",createArtifactServiceRoutes());
      const endpoint=`/${resource.id}/storage/file?key=http-file`;
      total=20;single=20;
      const payload=new Uint8Array(17*1024*1024);payload[0]=128;payload[payload.length-1]=255;
      expect((await api.request(endpoint,{method:"PUT",headers:{"content-type":"application/pdf"},body:payload})).status).toBe(200);
      const downloaded=await api.request(endpoint);
      expect(downloaded.headers.get("content-type")).toBe("application/pdf");
      expect(Bun.hash(await downloaded.arrayBuffer())).toBe(Bun.hash(payload));
      expect((await api.request(endpoint+"&management=true",{method:"PUT",body:"denied"})).status).toBe(403);
      expect((await api.request(`/${resource.id}/storage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({area:"files",operation:"read",key:"http-file"})})).status).toBe(400);
      await artifacts.storage(resource.id,{area:"files",operation:"delete",key:"http-file"},reader);
      total=1;single=1;
      // KV is independent even with >1,000 files and an almost full file budget.
      await artifacts.storage(resource.id,{area:"kv",operation:"write",key:"state",content:JSON.stringify("x".repeat(600000))},reader);
      total=2;single=2;
      await write("oversized-after-lowering",new Uint8Array(1200000));
      total=1;single=1;
      await write("oversized-after-lowering",new Uint8Array(1100000));
      await expect(write("new",new Uint8Array(1))).rejects.toMatchObject({code:"STORAGE_FULL"});
      await artifacts.storage(resource.id,{area:"files",operation:"delete",key:"oversized-after-lowering"},reader);
      // Migration preserves old binary content and is repeatable.
      await sql`INSERT INTO assistant.artifact_storage(artifact_id,area,key,content,bytes)
        VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${resource.id}),'files','legacy','AID/',3)`;
      await migrateArtifacts();
      // This old fixture intentionally exercises a legacy write grant. The
      // migration upgrades it; restore the fixture for subsequent tests.
      await sql`UPDATE auth.access SET permission='write' WHERE user_id=${editor.user.id}::uuid
        AND id IN (SELECT access_id FROM assistant.artifact_access WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${id}))`;
      const legacy=await artifacts.storage(resource.id,{area:"files",operation:"read",key:"legacy"},reader);
      expect("item" in legacy && [...legacy.item!.data!]).toEqual([0,128,255]);
    } finally { if(cleanup) await artifacts.remove(cleanup,owner); settings.mockRestore(); }
  },30000);

  test("artifact revisions store JSON objects and retain immutable source", async () => {
    const created = await artifacts.create({ title: "JSON source", source }, owner);
    const changed = { ...source, files: [{ path: "main.js", content: 'export default () => "null"' }] };
    await artifacts.update(created.id, { title: "JSON source", expectedRevision: 1, source: changed }, owner);
    const rows = await sql<{ revision: number; kind: string; source: string }[]>`SELECT revision,jsonb_typeof(source) AS kind,source::text AS source
      FROM assistant.artifact_revisions WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${created.id}) ORDER BY revision`;
    expect(rows.map(row => row.kind)).toEqual(["object", "object"]);
    expect(rows.map(row => JSON.parse(row.source))).toEqual([source, changed]);
    expect((await artifacts.get(created.id, owner)).source).toEqual(changed);
  });

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
    const described = await artifacts.describe([id, "invalid"], owner.user.id);
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({ id, title: "Analysis", description: "", icon: "ti ti-app-window",kind:"app",revision:1,publishedVersion:null,permission:"admin",publishedRevision:null });
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

  test("reviewed app grants reject stale approval and serialize concurrent changes", async () => {
    const resource = await artifacts.create({ title: "Reviewed sharing", source }, owner);
    const context = { ...owner, locale: "en", signal: new AbortController().signal };
    const grants = await artifacts.access(resource.id, owner);
    const input = { id: resource.id, expectedAccessRevision: accessRevision(grants),
      principal: { type: "user" as const, userId: reader.user.id }, permission: "read" as const };
    await sql`UPDATE auth.users SET display_name='Review recipient' WHERE id=${reader.user.id}::uuid`;
    const preview = await artifactCodeHandlers.code_access_change(input, { ...context, review: true });
    await sql`UPDATE auth.users SET display_name='Test' WHERE id=${reader.user.id}::uuid`;
    const previewText = JSON.stringify(preview);
    expect(previewText).toContain("Review recipient");
    expect(previewText).toContain(reader.user.id);
    expect(preview).toMatchObject({ ok: true, data: { data: { message: expect.stringContaining("Reviewed sharing") } } });
    expect(await artifacts.access(resource.id, owner)).toEqual(grants);
    const results = await Promise.all([
      artifactCodeHandlers.code_access_change(input, context),
      artifactCodeHandlers.code_access_change({ ...input, principal: { type: "user", userId: editor.user.id } }, context),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await artifactCodeHandlers.code_access_change(input, { ...context, review: true }))
      .toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const latest = await artifacts.access(resource.id, owner);
    const manager = latest.find(grant => grant.permission === "admin")!;
    expect(await artifactCodeHandlers.code_access_change({ id: resource.id, accessId: manager.id,
      expectedAccessRevision: accessRevision(latest), permission: null }, context))
      .toMatchObject({ ok: false, error: { code: "LAST_MANAGER" } });
    expect(await artifactCodeHandlers.code_access_read({ id: resource.id }, { ...stranger, locale: "en", signal: context.signal }))
      .toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
  });

  test("generic App file copies preserve binary bytes with Use and reject stale overwrite or denial", async () => {
    const from = await artifacts.create({ title: "Source files", source }, owner);
    const to = await artifacts.create({ title: "Target files", source }, owner);
    for (const resource of [from, to]) {
      await artifacts.publish(resource.id, 1, owner, "Ready");
      await artifacts.grant(resource.id, { type: "user", userId: reader.user.id }, "read", owner);
    }
    const bytes = new Uint8Array([0, 128, 255, 10]);
    await artifacts.storage(from.id, { area: "files", operation: "write", key: "invoice.pdf", mediaType: "application/pdf" }, owner, false, bytes);
    const file = await studioFiles.read({ scope: "app", id: from.id, path: "invoice.pdf" }, reader);
    const destination = { scope: "app" as const, id: to.id, path: "invoice.pdf" };
    const context = { ...reader, locale: "en", signal: new AbortController().signal };
    const input = { source: file!.reference, destination, expectedVersion: null };
    expect(await artifactCodeHandlers.code_file_copy(input, { ...context, review: true })).toMatchObject({ ok: true, data: { data: { message: expect.stringContaining("other authorized users") } } });
    expect(await studioFiles.read(destination, reader)).toBeNull();
    expect(await artifactCodeHandlers.code_file_copy(input, context)).toMatchObject({ ok: true });
    expect((await studioFiles.read(destination, reader))?.bytes).toEqual(bytes);
    expect(await artifactCodeHandlers.code_file_copy(input, context)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await expect(studioFiles.copy(file!.reference, destination, null, stranger, context.signal)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await artifacts.storage(from.id, { area: "files", operation: "write", key: "invoice.pdf" }, owner, false, new Uint8Array([1]));
    await expect(studioFiles.readReference(file!.reference, reader)).rejects.toMatchObject({ code: "CONFLICT" });
    const abort = AbortSignal.abort();
    const current = await studioFiles.read({ scope: "app", id: from.id, path: "invoice.pdf" }, reader);
    await expect(studioFiles.copy(current!.reference, { ...destination, path: "cancelled.pdf" }, null, reader, abort)).rejects.toBeInstanceOf(Error);
    expect(await studioFiles.read({ ...destination, path: "cancelled.pdf" }, reader)).toBeNull();
  });

  test("storage reviews reject intervening writes and file versions survive delete/recreate", async () => {
    const resource = await artifacts.create({ title: "Storage review", source }, owner);
    const context = { ...owner, locale: "en", signal: new AbortController().signal };
    const write = () => artifacts.storage(resource.id, { area: "kv", operation: "write", key: "state", content: "{}" }, owner);
    await write();
    const state = await artifacts.storageState(resource.id, owner);
    const input = { id: resource.id, area: "kv" as const, expectedStorageRevision: state.storageRevision };
    expect(await artifactCodeHandlers.code_storage_delete(input, { ...context, review: true }))
      .toMatchObject({ ok: true, data: { data: { message: expect.stringContaining("Storage review") } } });
    await write();
    expect(await artifactCodeHandlers.code_storage_delete(input, context)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const before = await artifacts.storage(resource.id, { area: "kv", operation: "read", key: "state" }, owner);
    const current = await artifacts.storageState(resource.id, owner);
    expect(await artifactCodeHandlers.code_storage_delete({ ...input, expectedStorageRevision: current.storageRevision }, context))
      .toMatchObject({ ok: true, data: { data: { cleared: true } } });
    await write();
    const after = await artifacts.storage(resource.id, { area: "kv", operation: "read", key: "state" }, owner);
    expect(after.item?.version).toBeGreaterThan(before.item!.version);
    await expect(artifacts.storage(resource.id, { area: "kv", operation: "delete", key: "state" }, owner, true, undefined, { version: before.item!.version }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await artifacts.get(resource.id, owner)).source).toEqual(source);
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
    const created = await artifactCodeHandlers.code_create({ title: "Agent test" }, context);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.data.id;
    const write = async (path: string, content: string) => artifactCodeHandlers.code_write({ id, expectedRevision: (await artifacts.get(id, owner)).revision, files: [{ path, content }] }, context);
    const intermediate = await write("main.ts", 'import {value} from "./helper.ts"; export default () => value;');
    expect(intermediate).toMatchObject({ ok: true, data: { data: { saved: true } } });
    if (!intermediate.ok) throw new Error("Write failed");
    expect(z.object({ diagnostics: z.array(z.unknown()) }).parse(intermediate.data.data).diagnostics.length).toBeGreaterThan(0);
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
      keywords: [], pinnedAt: null, done: null, isDone: false, lastUsedAt: "2026-09-14T00:00:00.000Z", archivedAt: null, runStatus: "needs_attention", runError: null, unreadCompletion: false,
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
      for (const result of ["null", "42", '{"x":1}', "hello", null, { x: 1 }, ["null", 42], 42, true]) {
        await sql`UPDATE assistant.artifact_client_calls SET result=NULL WHERE turn_id=${turnId}::uuid`;
        await clientCalls.complete({ ...winner, result }, owner);
        expect(await clientCalls.claim(loser, owner)).toEqual({ status: "done", result });
        const [stored] = await sql<{ input_kind: string; result: string }[]>`SELECT jsonb_typeof(input) AS input_kind,result::text AS result
          FROM assistant.artifact_client_calls WHERE turn_id=${turnId}::uuid`;
        expect(stored?.input_kind).toBe("object");
        expect(JSON.parse(stored!.result)).toEqual(result);
      }
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
    expect((await artifacts.list(owner,1,"Chart totals")).items.map(item=>item.id)).toContain(app.id);
    expect((await artifacts.list(reader,1,"Chart totals")).items.map(item=>item.id)).not.toContain(app.id);
    expect((await artifacts.list(reader,1,"Budget")).items.map(item=>item.id)).toContain(app.id);
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
    const definitions=defineCapabilities({protocolVersion:2,actions:{write:{title:"Write item",description:"Write a test item",input:z.object({value:z.string().describe("Value")}).strict(),data:z.unknown(),approval:"rememberable",idempotency:"required",destructive:false,openWorld:false,
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
      expect(await runtimeCapabilities.resolve(approved.id,{approved:true},owner,caller)).toEqual({status:"completed",result:{ok:true,data:{data:{written:true}}}});
      const [stored] = await sql<{ request: string; prepared: string; result: string }[]>`SELECT jsonb_typeof(request) AS request,jsonb_typeof(prepared) AS prepared,jsonb_typeof(result) AS result
        FROM assistant.capability_calls WHERE id=${approved.id}::uuid`;
      expect(stored).toEqual({request:"object",prepared:"object",result:"object"});
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
    const definitions=defineCapabilities({protocolVersion:2,
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

  test("reviewed App deletion rejects storage changes and removes only the reviewed resource", async () => {
    const resource = await artifacts.create({ title: "Delete review", source }, owner);
    const context = { ...owner, locale: "en", signal: new AbortController().signal };
    const before = await artifacts.managementState(resource.id, owner);
    const input = { id: resource.id, expectedManagementRevision: before.managementRevision };
    expect(await artifactCodeHandlers.code_delete(input, { ...context, review: true }))
      .toMatchObject({ ok: true, data: { data: { message: expect.stringContaining("Delete review") } } });
    await artifacts.storage(resource.id, { area: "kv", operation: "write", key: "new", content: "1" }, owner);
    expect(await artifactCodeHandlers.code_delete(input, context)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const latest = await artifacts.managementState(resource.id, owner);
    expect(await artifactCodeHandlers.code_delete({ ...input, expectedManagementRevision: latest.managementRevision }, context))
      .toMatchObject({ ok: true, data: { data: { deleted: true, databaseCleanupQueued: false } } });
    await expect(artifacts.get(resource.id, owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await artifacts.get(id, owner)).id).toBe(id);
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
    const settings=spyOn(app.settings,"get").mockImplementation(async key => ({"assistant.storage_total_mib":250,"assistant.storage_file_mib":50,"assistant.rsql_url":url,"assistant.rsql_api_token":token}[key]));
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
    const resource=await artifacts.create({title:"Excel import",kind:"app",source},owner);
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>({"assistant.storage_total_mib":250,"assistant.storage_file_mib":50,"assistant.rsql_url":process.env.RSQL_TEST_URL!,"assistant.rsql_api_token":"artifact-test-only"}[key]));
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

  (process.env.RSQL_TEST_URL ? test : test.skip)("database clear preserves schema and every attempted write invalidates reviewed state", async () => {
    const settings = spyOn(app.settings, "get").mockImplementation(async key => ({ "assistant.storage_total_mib": 250, "assistant.storage_file_mib": 50, "assistant.rsql_url": process.env.RSQL_TEST_URL!, "assistant.rsql_api_token": "artifact-test-only" }[key]));
    const resource = await artifacts.create({ title: "Clear rows", source }, owner);
    try {
      await artifactDatabase.connect(resource.id, owner);
      await artifactDatabase.call(resource.id, { operation: "tables.create", name: "records", columns: [{ name: "key", type: "text", unique: true }] }, owner);
      await artifactDatabase.call(resource.id, { operation: "rows.insert", table: "records", rows: { key: "first" } }, owner);
      // Leave exactly one ordinary pool connection for the mutation transaction.
      // Its durable intent must not wait for a second connection from that pool.
      const reserved = await Promise.all(Array.from({ length: (sql.options.max ?? 10) - 1 }, () => sql.reserve()));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          artifactDatabase.call(resource.id, { operation: "rows.insert", table: "records", rows: { key: "pool-check" } }, owner),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Mutation exhausted the ordinary SQL pool")), 2000); }),
        ]);
      } finally { clearTimeout(timeout); for (const connection of reserved) connection.release(); }
      const before = await artifactDatabase.status(resource.id, owner);
      await expect(artifactDatabase.call(resource.id, { operation: "rows.insert", table: "records", rows: { key: "first" } }, owner)).rejects.toBeInstanceOf(Error);
      const afterFailure = await artifactDatabase.status(resource.id, owner);
      expect(afterFailure.dataRevision).not.toBe(before.dataRevision);
      await expect(artifactDatabase.clear(resource.id, before.generation!, before.dataRevision!, owner)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await artifactDatabase.clear(resource.id, afterFailure.generation!, afterFailure.dataRevision!, owner)).toEqual({ completed: true, clearedTables: ["records"] });
      expect(await artifactDatabase.call(resource.id, { operation: "rows.list", table: "records" }, owner)).toMatchObject({ data: [] });
      expect(await artifactDatabase.call(resource.id, { operation: "schema.get", table: "records" }, owner)).toMatchObject({ name: "records" });
      expect((await artifacts.get(resource.id, owner)).source).toEqual(source);
    } finally { await artifacts.remove(resource.id, owner); settings.mockRestore(); }
  });

  (process.env.RSQL_TEST_URL ? test : test.skip)("partial clear reports progress and releases serialization after cancellation", async () => {
    const controller = new AbortController();
    let deletes = 0;
    const proxy = Bun.serve({ port:0, async fetch(request) {
      if (request.method === "DELETE" && ++deletes === 2) {
        controller.abort();
        return new Response("cancelled",{status:503});
      }
      const target = new URL(request.url); const base = new URL(process.env.RSQL_TEST_URL!);
      target.host = base.host;
      return fetch(new Request(target,request));
    }});
    const settings = spyOn(app.settings,"get").mockImplementation(async key=>({"assistant.storage_total_mib":250,"assistant.storage_file_mib":50,"assistant.rsql_url":proxy.url.toString(),"assistant.rsql_api_token":"artifact-test-only"}[key]));
    const resource = await artifacts.create({title:"Partial clear",source},owner);
    try {
      await artifactDatabase.connect(resource.id,owner);
      for (const table of ["first","second"]) {
        await artifactDatabase.call(resource.id,{operation:"tables.create",name:table,columns:[{name:"value",type:"text"}]},owner);
        await artifactDatabase.call(resource.id,{operation:"rows.insert",table,rows:{value:"keep"}},owner);
      }
      const before=await artifactDatabase.status(resource.id,owner);
      const cleared=await artifactDatabase.clear(resource.id,before.generation!,before.dataRevision!,owner,controller.signal);
      expect(cleared).toMatchObject({completed:false,clearedTables:["first"],failedTable:"second",error:"DB_CANCELLED"});
      const after=await artifactDatabase.status(resource.id,owner);
      expect(after.dataRevision).not.toBe(before.dataRevision);
      expect(await artifactDatabase.call(resource.id,{operation:"rows.list",table:"first"},owner)).toMatchObject({data:[]});
      expect(await artifactDatabase.call(resource.id,{operation:"rows.list",table:"second"},owner)).toMatchObject({data:[{value:"keep"}]});
      await expect(artifactDatabase.clear(resource.id,before.generation!,before.dataRevision!,owner)).rejects.toMatchObject({code:"CONFLICT"});
      const context={...owner,locale:"en",signal:new AbortController().signal};
      expect(await artifactCodeHandlers.code_database_reset({id:resource.id,expectedGeneration:before.generation!,expectedDataRevision:before.dataRevision!},context)).toMatchObject({ok:false,error:{code:"CONFLICT"}});
    } finally { await artifacts.remove(resource.id,owner); settings.mockRestore(); proxy.stop(true); }
  });

  test("database connection errors distinguish invalid credentials from an unavailable server", async () => {
    const applet = await artifacts.create({title:"Database errors",source},owner);
    const upstream = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>Response.json({error:"unauthorized"},{status:401})});
    const settings = spyOn(app.settings,"get").mockImplementation(async key => ({"assistant.storage_total_mib":250,"assistant.storage_file_mib":50,"assistant.rsql_url":upstream.url.origin,"assistant.rsql_api_token":"private-fixture-token"}[key]));
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
    await artifacts.storage(resource.id,{area:"files",operation:"write",key:"keep.txt"},owner,false,new Uint8Array([97]));
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
    expect(await artifacts.storage(resource.id,{area:"files",operation:"read",key:"keep.txt"},reader)).toMatchObject({item:{data:new Uint8Array([97])}});
    expect((await artifacts.get(resource.id,owner)).publishedRevision).toBe(1);
  });

  (process.env.RSQL_TEST_URL ? test : test.skip)("Studio database backup and reset preserve source and rotate namespace generations",async()=>{
    const resource=await artifacts.create({title:"Reset lifecycle",source},owner);
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>({"assistant.storage_total_mib":250,"assistant.storage_file_mib":50,"assistant.rsql_url":process.env.RSQL_TEST_URL!,"assistant.rsql_api_token":"artifact-test-only"}[key]));
    try{
      expect(await artifactDatabase.status(resource.id,owner)).toMatchObject({configured:true,connected:false});
      expect(await sql`SELECT 1 FROM assistant.artifact_databases WHERE artifact_id=(SELECT id FROM assistant.artifacts WHERE short_id=${resource.id})`).toHaveLength(0);
      await artifactDatabase.connect(resource.id,owner,undefined,true);
      await artifactDatabase.call(resource.id,{operation:"tables.create",name:"ledger",columns:[{name:"amount",type:"integer"}]},owner);
      await artifactDatabase.call(resource.id,{operation:"rows.insert",table:"ledger",rows:[{amount:1200}]},owner,undefined,"maintenance");
      const conversation = { id:crypto.randomUUID() };
      await sql`INSERT INTO ai.conversations VALUES(${conversation.id}::uuid,${owner.user.id}::uuid,NULL)`;
      const conversationRead = spyOn(aiConversations,"getConversation").mockResolvedValue({
        id:conversation.id,shortId:"abc234",title:"Export test",titleSource:"user",description:"",descriptionSource:"user",keywords:[],pinnedAt:null,done:null,isDone:false,lastUsedAt:new Date().toISOString(),archivedAt:null,
        runStatus:"idle",runError:null,unreadCompletion:false,projectId:null,draft:{content:[],revision:1,updatedAt:null},createdByUserId:owner.user.id,
        createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      });
      try {
        const context={...owner,conversationId:conversation.id,locale:"en",signal:new AbortController().signal};
        expect(await artifactCodeHandlers.code_database_export({id:resource.id,path:"/database.sqlite"},context)).toMatchObject({ok:true});
        const before=await sql`SELECT bytes,version FROM ai.files WHERE conversation_id=${conversation.id}::uuid AND path='/database.sqlite'`;
        expect(await artifactCodeHandlers.code_database_export({id:resource.id,path:"/database.sqlite"},context)).toMatchObject({ok:false,error:{code:"CONFLICT",status:409,message:expect.stringContaining("nothing was written")}});
        expect(await sql`SELECT bytes,version FROM ai.files WHERE conversation_id=${conversation.id}::uuid AND path='/database.sqlite'`).toEqual(before);
      } finally { conversationRead.mockRestore(); await sql`DELETE FROM ai.files WHERE conversation_id=${conversation.id}::uuid`; await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`; }
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
    const settings=spyOn(app.settings,"get").mockImplementation(async key=>({"assistant.storage_total_mib":250,"assistant.storage_file_mib":50,"assistant.rsql_url":upstream.url.origin,"assistant.rsql_api_token":"secret-fixture"}[key]));
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
    await artifacts.storage(app.id,{area:"files",operation:"write",key:"input.csv",mediaType:"text/csv"},reader,false,new TextEncoder().encode("a,b\n1,2"));
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

  test("project app selection only exposes manageable candidates and linking requires both admin grants", async () => {
    const projectId = crypto.randomUUID();
    const project = spyOn(aiProjects,"get").mockImplementation(async (id,subject,permission) => {
      const projectAdmin = subject?.type === "user" && [owner.user.id, reader.user.id].includes(subject.userId);
      const projectReader = subject?.type === "user" && subject.userId === stranger.user.id;
      return id === projectId && (projectAdmin || projectReader && permission === "read")
        ? {id,shortId:"linkproj",name:"Project",description:"",icon:"",instructions:"",defaultModelProfileId:null,
          permission:projectAdmin ? "admin" : "read",revision:1,createdAt:"",updatedAt:""} : null;
    });
    const shortProject = spyOn(aiProjects,"getByShortId").mockImplementation(async (shortId,subject,permission) =>
      shortId === "linkproj" ? aiProjects.get(projectId,subject,permission) : null);
    try {
      const app = await artifacts.create({title:"Project selection draft",source},owner);
      await artifacts.grant(app.id,{type:"user",userId:reader.user.id},"read",owner);
      expect((await artifacts.projectApps("linkproj",owner,1,"Project selection",true)).items).toMatchObject([{id:app.id,canManage:true,linked:false,published:false}]);
      expect((await artifacts.projectApps("linkproj",reader,1,"Project selection",true)).items).toEqual([]);
      await expect(artifacts.projectApps("linkproj",stranger,1,"",true)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.projectApps("linkproj",editor)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.linkProject(app.id,"linkproj",true,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      const privateApp = await artifacts.create({title:"No project access",source},editor);
      await expect(artifacts.linkProject(privateApp.id,"linkproj",true,editor)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await artifacts.linkProject(app.id,"linkproj",true,owner);
      expect((await artifacts.projectApps("linkproj",owner)).items).toMatchObject([{id:app.id,linked:true,published:false}]);
      expect((await artifacts.projectApps("linkproj",owner,1,"Project selection",true)).items).toEqual([]);
      expect((await artifacts.projectApps("linkproj",reader)).items).toEqual([]);
      await artifacts.publish(app.id,1,owner,"Initial release");
      expect((await artifacts.projectApps("linkproj",stranger)).items).toMatchObject([{id:app.id,canManage:false,published:true}]);
      expect((await artifacts.projectApps("linkproj",stranger,1,"does not match")).items).toEqual([]);
      await expect(artifacts.linkProject(app.id,"linkproj",false,reader)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await artifacts.linkProject(app.id,projectId,false,owner);
      expect((await artifacts.projectApps("linkproj",owner)).items).toEqual([]);
    } finally { project.mockRestore(); shortProject.mockRestore(); }
  });

  test("project membership grants published Use everywhere and revocation never changes direct grants", async () => {
    const projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
    await sql`INSERT INTO ai.projects(id,short_id,name) VALUES(${projectId}::uuid,'project1','Shared project')`;
    await sql`INSERT INTO auth.groups(id,name) VALUES(${groupId}::uuid,'Project members')`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${stranger.user.id}::uuid,${groupId}::uuid)`;
    const [manager] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${owner.user.id}::uuid,'admin') RETURNING id`;
    const [members] = await sql`INSERT INTO auth.access(group_id,permission) VALUES(${groupId}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO ai.project_access VALUES(${projectId}::uuid,${manager!.id}::uuid),(${projectId}::uuid,${members!.id}::uuid)`;
    const script = await artifacts.create({title:"Shared calculation",source},owner);
    const contextual = {...stranger,conversationId:crypto.randomUUID()};
    try {
      await artifacts.linkProject(script.id,"project1",true,owner);
      expect(await artifacts.projects(script.id,owner)).toEqual([{projectId,shortId:"project1",name:"Shared project"}]);
      await expect(artifacts.get(script.id,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      expect((await artifacts.list(stranger,1,"Shared calculation")).items).toEqual([]);
      await artifacts.publish(script.id,1,owner,"Initial release");
      expect((await artifacts.get(script.id,stranger)).permission).toBe("read");
      expect((await artifacts.get(script.id,contextual)).permission).toBe("read");
      expect(await artifacts.describe([script.id],stranger.user.id)).toHaveLength(1);
      expect((await artifacts.list(stranger,1,"Shared calculation")).items).toMatchObject([{id:script.id,permission:"read"}]);
      expect(await artifacts.runner(script.id,stranger)).toMatchObject({serverAccess:true,canManage:false});
      await expect(artifacts.runner(script.id,{})).rejects.toMatchObject({code:"NOT_FOUND"});
      const toolContext = {...stranger,locale:"en",signal:new AbortController().signal};
      expect(await artifactCodeHandlers.code_read({id:script.id,path:"main.js",offset:0},toolContext))
        .toMatchObject({ok:true,data:{data:{content:source.files[0]!.content}}});
      expect((await artifacts.fork(script.id,stranger)).permission).toBe("admin");
      await artifacts.storage(script.id,{area:"kv",operation:"write",key:"shared",content:"42"},owner);
      expect(await artifacts.storage(script.id,{area:"kv",operation:"read",key:"shared"},stranger)).toMatchObject({item:{content:"42"}});
      await expect(artifacts.writeFile(script.id,"main.js","export default () => 2",stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.linkProject(script.id,projectId,false,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.grant(script.id,{type:"authenticated"},"read",stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      const successorGrant = await artifacts.grant(script.id,{type:"user",userId:reader.user.id},"admin",owner);
      const creatorGrant = (await artifacts.access(script.id,owner)).find(entry=>entry.principal.type === "user" && entry.principal.userId === owner.user.id)!;
      await artifacts.changeGrant(script.id,creatorGrant.id,null,reader);
      await sql`DELETE FROM ai.project_access WHERE project_id=${projectId}::uuid AND access_id=${manager!.id}::uuid`;
      expect((await artifacts.get(script.id,stranger)).permission).toBe("read");
      expect(await artifacts.projects(script.id,reader)).toEqual([{projectId,shortId:null,name:null}]);
      await artifacts.grant(script.id,{type:"user",userId:owner.user.id},"admin",reader);
      await sql`INSERT INTO ai.project_access VALUES(${projectId}::uuid,${manager!.id}::uuid)`;
      await artifacts.changeGrant(script.id,successorGrant!.id,null,owner);
      const updated=await artifacts.writeFile(script.id,"main.js","export default () => 2",owner);
      expect((await artifacts.get(script.id,stranger)).source).toEqual(source);
      await expect(artifacts.get(script.id,stranger,updated.revision)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id=${stranger.user.id}::uuid AND group_id=${groupId}::uuid`;
      await expect(artifacts.get(script.id,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await expect(artifacts.runner(script.id,stranger)).rejects.toMatchObject({code:"NOT_FOUND"});
      await expect(artifacts.storage(script.id,{area:"kv",operation:"read",key:"shared"},stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      expect(await artifacts.describe([script.id],stranger.user.id)).toEqual([]);
      expect((await artifacts.list(stranger,1,"Shared calculation")).items.some(item=>item.id===script.id)).toBe(false);
      await sql`INSERT INTO auth.user_groups_v2 VALUES(${stranger.user.id}::uuid,${groupId}::uuid)`;
      await artifacts.linkProject(script.id,projectId,false,owner);
      await expect(artifacts.get(script.id,stranger)).rejects.toMatchObject({code:"ACCESS_DENIED"});
      await artifacts.grant(script.id,{type:"user",userId:stranger.user.id},"read",owner);
      expect((await artifacts.get(script.id,stranger)).permission).toBe("read");
      await artifacts.linkProject(script.id,projectId,true,owner);
      await artifacts.linkProject(script.id,projectId,false,owner);
      expect((await artifacts.runner(script.id,stranger)).serverAccess).toBe(true);
      // App managers can see the link, but cannot read private project metadata.
      await artifacts.grant(script.id,{type:"user",userId:reader.user.id},"admin",owner);
      await artifacts.linkProject(script.id,projectId,true,owner);
      expect(await artifacts.projects(script.id,reader)).toEqual([{projectId,shortId:null,name:null}]);
      await artifacts.unpublish(script.id,owner);
      await expect(artifacts.get(script.id,stranger)).rejects.toMatchObject({code:"NOT_FOUND"});
    } finally { await artifacts.remove(script.id,owner); }
  });

  test("edit creates an unsent chat draft and indexes the app reference for admins only", async () => {
    const conversationId = crypto.randomUUID();
    const create = spyOn(aiConversations, "createConversation").mockImplementation(async input => ({
      id: conversationId, shortId: "edit01", title: input.title!, titleSource: "user", description: "", descriptionSource: "user",
      keywords: [], pinnedAt: null, done: null, isDone: false, lastUsedAt: "2026-09-14T00:00:00.000Z", archivedAt: null, runStatus: "idle", runError: null, unreadCompletion: false,
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
      id:conversationId,shortId:"abc234",title:"Host test",titleSource:"user",description:"",descriptionSource:"user",keywords:[],pinnedAt:null,done:null,isDone:false,lastUsedAt:"2026-09-14T00:00:00.000Z",archivedAt:null,
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
      id:conversationId,shortId:"abc234",title:"Host test",titleSource:"user",description:"",descriptionSource:"user",keywords:[],pinnedAt:null,done:null,isDone:false,lastUsedAt:"2026-09-14T00:00:00.000Z",archivedAt:null,
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
      const exampleSettings = spyOn(app.settings, "get").mockImplementation(async key => ({ "assistant.storage_total_mib": 250, "assistant.storage_file_mib": 50, "assistant.rsql_url": process.env.RSQL_TEST_URL!, "assistant.rsql_api_token": "artifact-test-only" }[key]));
      try {
        for (const [folder, action, input, expected] of [
          ["converter", "convert", { csv: "name,amount\nTea,4\nCoffee,5" }, { rows: 2 }],
          ["importer", "importItems", { items: [{ key: "record-1", value: "shared value" }] }, { inserted: 1, skipped: 0 }],
          ["dashboard", "setStatus", { message: "All checks passed" }, { saved: true }],
          ["invoice-matcher", "linkTransaction", { transactionKey: "bank-42", invoicePath: "invoices/INV-7.pdf" }, { linked: true, unchanged: false }],
        ] as const) {
          const directory = new URL(`../../examples/studio-actions/${folder}/`, import.meta.url);
          const files = await Promise.all((await readdir(directory)).filter(path => path.endsWith(".js") || path === "app.actions.json").map(async path => ({ path, content: await Bun.file(new URL(path, directory)).text() })));
          const example = await artifacts.create({ title: folder, source: { entry: "main.js", files } }, owner);
          try {
            const setup = files.find(file => file.path === "setup.js");
            if (setup) expect(await wait({ ...call, callId: `${folder}-setup`, args: { code: setup.content, resourceId: example.id } })).toMatchObject({ status: "done", result: { status: "ready" } });
            if (folder === "invoice-matcher") await artifacts.storage(example.id, { area: "files", operation: "write", key: "invoices/INV-7.pdf", mediaType: "application/pdf" }, owner, false, new TextEncoder().encode("Fixture invoice"));
            await artifacts.publish(example.id, 1, owner, "Example release");
            const invoke = { ...call, name: "code_action" as const, callId: `${folder}-action`, args: { id: example.id, action, publishedVersion: 1, input } };
            expect(await wait(invoke)).toMatchObject({ status: "done", result: { status: "ready", output: JSON.stringify(expected) } });
            if (folder === "importer") expect(await wait({ ...invoke, callId: "importer-second-session" })).toMatchObject({ status: "done", result: { output: '{"inserted":0,"skipped":1}' } });
            if (folder === "invoice-matcher") expect(await wait({ ...invoke, callId: "invoice-link-repeat" })).toMatchObject({ status: "done", result: { output: '{"linked":true,"unchanged":true}' } });
            if (folder === "dashboard") expect(await wait({ ...call, callId: "dashboard-view", args: { id: example.id } })).toMatchObject({ status: "done", result: { status: "ready" } });
          } finally { await artifacts.remove(example.id, owner); }
        }
      } finally { exampleSettings.mockRestore(); }
      const generated=Array.from({length:1000},(_,index)=>({index,amount:"123456789.123400",region:"Süd"}));
      const produce={...call,callId:"produce-data",args:{code:`export default async()=>{await files.save(JSON.stringify(${JSON.stringify(generated)}),"data.json");return "saved";}`}};
      expect(await wait(produce)).toMatchObject({status:"done",result:{status:"ready"}});
      const exported=await wait({...call,name:"code_export",callId:"export-data",args:{runId:produce.callId,name:"data.json"}});
      const file=z.object({path:z.string(),version:z.number()}).parse("result" in exported ? exported.result : null);
      const resource=await artifacts.create({title:"Imported data",source},owner);
      const fileReference=(await studioFiles.read({scope:"chat",id:context.conversationId,path:file.path},context))!.reference;
      const written=await artifactCodeHandlers.code_write({id:resource.id,expectedRevision:1,entry:"main.ts",files:[
        {path:"data.json",fromFile:fileReference},{path:"main.ts",content:'import data from "./data.json"; export default()=>({rows:data.length,first:data[0],last:data.at(-1)});'},
      ]},context);
      expect(written.ok).toBe(true);
      expect((await artifacts.get(resource.id,owner)).source.files.find(file=>file.path==="data.json")?.content).toBe(JSON.stringify(generated));
      expect(await wait({...call,callId:"run-import",args:{id:resource.id}})).toMatchObject({status:"done",result:{status:"ready",id:resource.id,revision:2,output:JSON.stringify({rows:1000,first:generated[0],last:generated.at(-1)})}});
      const stale=await artifactCodeHandlers.code_write({id:resource.id,expectedRevision:2,files:[{path:"data.json",fromFile:{scope:"chat",id:context.conversationId,path:file.path,version:"2"}}]},context);
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
