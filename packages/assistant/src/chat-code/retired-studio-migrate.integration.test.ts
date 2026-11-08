import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as services from "@k2b/cloud/services";
import { secrets } from "@k2b/cloud/services";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrateAssistant } from "../migrate";
import { createLegacyChatSchema } from "./retired-studio.test-fixture";

const userId = "11000000-0000-4000-8000-000000000001";
const chatId = "11000000-0000-4000-8000-000000000002";
const turnId = "11000000-0000-4000-8000-000000000003";
const appId = "11000000-0000-4000-8000-000000000004";
const callId = "11000000-0000-4000-8000-000000000005";
const studioCallId = "11000000-0000-4000-8000-000000000006";
const revision = "11000000-0000-4000-8000-000000000007";

databaseSuite()("Studio retirement preserves chat authority and read-only evidence", () => {
  test.each(["fresh", "existing", "default-targets"] as const)("%s install retires Studio atomically and can restart", async (kind) => {
    const database = await useFreshDatabase(`studio_retirement_${kind}`);
    let restore: (() => void) | undefined;
    const removed: string[] = [];
    let cleanupStatus = 503;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.method).toBe("DELETE");
        expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
        removed.push(new URL(request.url).pathname);
        return new Response(null, { status: cleanupStatus });
      },
    });
    const cleanupUrl = `http://rsql:${server.port}`;
    try {
      await sql`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE TABLE auth.access(id uuid PRIMARY KEY);
        CREATE SCHEMA ai; CREATE TABLE ai.conversations(id uuid PRIMARY KEY);
        CREATE TABLE ai.turns(id uuid PRIMARY KEY REFERENCES ai.conversations(id));
        CREATE TABLE ai.files(conversation_id uuid,path text,data bytea,PRIMARY KEY(conversation_id,path));
        CREATE TABLE ai.conversation_resource_refs(resource_type text,resource_id text);
        CREATE TABLE ai.project_resource_refs(resource_type text,resource_id text);
        CREATE SCHEMA settings; CREATE TABLE settings.entries(key text PRIMARY KEY,value text);
        CREATE SCHEMA approvals; CREATE TABLE approvals.requests(requester_kind text,requester_ref text,requester_title text,status text)`.simple();
      await sql`INSERT INTO auth.users VALUES(${userId}::uuid)`;
      await sql`INSERT INTO ai.conversations VALUES(${chatId}::uuid),(${turnId}::uuid)`;
      await sql`INSERT INTO ai.turns VALUES(${turnId}::uuid)`;
      await sql`INSERT INTO ai.files VALUES(${chatId}::uuid,'/views/chart.view.json',decode('010203','hex'))`;
      await sql`INSERT INTO approvals.requests VALUES('assistant_turn',${callId},'Chat request','pending'),('studio_app',${studioCallId},NULL,'approved')`;
      const beforeFiles = await sql`SELECT * FROM ai.files`;
      const encrypted = await secrets.encrypt("private-chat-value");
      let chatCallBefore: unknown;
      let secretBefore: unknown;
      if (kind !== "fresh") {
        await sql`CREATE SCHEMA assistant;
          CREATE TABLE assistant.artifacts(id uuid PRIMARY KEY,title text);
          CREATE TABLE assistant.artifact_access(artifact_id uuid REFERENCES assistant.artifacts(id),access_id uuid REFERENCES auth.access(id) ON DELETE CASCADE);
          CREATE TABLE assistant.artifact_machine_rights(access_id uuid REFERENCES auth.access(id) ON DELETE CASCADE,rights jsonb);
          CREATE TABLE assistant.artifact_machine_secrets(artifact_id uuid REFERENCES assistant.artifacts(id),encrypted text);
          CREATE TABLE assistant.artifact_storage(artifact_id uuid REFERENCES assistant.artifacts(id),data bytea);
          CREATE TABLE assistant.artifact_databases(artifact_id uuid REFERENCES assistant.artifacts(id),namespace text);
          CREATE TABLE assistant.database_cleanup(namespace text);
          CREATE TABLE assistant.artifact_revisions(artifact_id uuid REFERENCES assistant.artifacts(id),source jsonb);
          CREATE TABLE assistant.artifact_publications(artifact_id uuid REFERENCES assistant.artifacts(id),title text);
          CREATE TABLE assistant.artifact_projects(artifact_id uuid REFERENCES assistant.artifacts(id),project_id uuid);
          CREATE TABLE assistant.artifact_machine_runs(id uuid PRIMARY KEY,artifact_id uuid REFERENCES assistant.artifacts(id) ON DELETE CASCADE,status text);
          CREATE TABLE assistant.artifact_checks(user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,passed boolean);
          CREATE TABLE assistant.chat_presentations(artifact_id uuid REFERENCES assistant.artifacts(id) ON DELETE CASCADE,files jsonb)`.simple();
        await createLegacyChatSchema();
        await sql`ALTER TABLE assistant.http_secrets ADD CONSTRAINT secret_studio_fk FOREIGN KEY(resource_id) REFERENCES assistant.artifacts(id) ON DELETE CASCADE;
          ALTER TABLE assistant.capability_calls ADD CONSTRAINT call_studio_fk FOREIGN KEY(artifact_id) REFERENCES assistant.artifacts(id) ON DELETE CASCADE`.simple();
        await sql`INSERT INTO assistant.artifacts VALUES(${appId}::uuid,'Retired title')`;
        await sql`INSERT INTO auth.access VALUES(${appId}::uuid),(${userId}::uuid)`;
        await sql`INSERT INTO assistant.artifact_access VALUES(${appId}::uuid,${appId}::uuid)`;
        await sql`INSERT INTO assistant.artifact_machine_runs VALUES(${appId}::uuid,${appId}::uuid,'done')`;
        await sql`INSERT INTO assistant.artifact_checks VALUES(${userId}::uuid,true)`;
        await sql`INSERT INTO assistant.chat_presentations VALUES(${appId}::uuid,'[{"path":"index.html"}]'::jsonb)`;
        await sql`INSERT INTO assistant.http_secrets(user_id,scope,name,resource_id,origin,header,prefix,encrypted,revision)
          VALUES(${userId}::uuid,${"chat:" + chatId},'crm',NULL,'https://example.com','authorization','Bearer ',${encrypted},${revision}::uuid),
          (${userId}::uuid,'resource:App234','crm',${appId}::uuid,'https://example.com','authorization','Bearer ',${encrypted},${revision}::uuid)`;
        await sql`INSERT INTO assistant.capability_calls(id,user_id,artifact_id,conversation_id,request,prepared,status,approval_id)
          VALUES(${callId}::uuid,${userId}::uuid,NULL,${chatId},(${JSON.stringify({ id: callId, name: "demo.write", input: {}, conversationId: chatId })}::text)::jsonb,'{}','pending',${callId}::uuid),
          (${studioCallId}::uuid,${userId}::uuid,${appId}::uuid,${chatId},(${JSON.stringify({ id: studioCallId, artifactId: "App234", name: "demo.write", input: {}, conversationId: chatId })}::text)::jsonb,'{}','pending',${studioCallId}::uuid)`;
        await sql`INSERT INTO assistant.artifact_agent_calls(turn_id,call_id,user_id,conversation_id,host_id,input,status,result)
          VALUES(${turnId}::uuid,'chat-call',${userId}::uuid,${chatId}::uuid,${appId}::uuid,'{"operation":"run","code":"export default()=>1","inputPaths":[]}'::jsonb,'done','{"output":"1"}'),
          (${turnId}::uuid,'studio-call',${userId}::uuid,${chatId}::uuid,${appId}::uuid,'{"operation":"action","id":"App234"}'::jsonb,'done','{"output":"old"}')`;
        await sql`INSERT INTO assistant.artifact_agent_approvals(turn_id,call_id,id,message,decision,remember)
          VALUES(${turnId}::uuid,'chat-call',${callId}::uuid,'Keep this decision',true,'{"toolName":"demo.write"}')`;
        await sql`INSERT INTO assistant.artifact_client_calls(user_id,turn_id,call_id,client_id,input,result)
          VALUES(${userId}::uuid,${turnId}::uuid,'secret',${callId}::uuid,'{"operation":"secret","name":"crm"}'::jsonb,'{"configured":true}')`;
        const storedHttp = await secrets.encrypt({
          id: callId,
          scope: { conversationId: chatId },
          createdAt: 1,
          request: { url: "https://example.com" },
          used: {},
        });
        await sql`INSERT INTO assistant.http_calls VALUES(${callId}::uuid,${userId}::uuid,'hash',${storedHttp},'pending','2026-01-01')`;
        await sql`INSERT INTO ai.conversation_resource_refs VALUES('assistant.artifact','App234'),('notebooks.note','Note23');
          INSERT INTO ai.project_resource_refs VALUES('assistant.app','App234'),('notebooks.note','Note23');
          INSERT INTO settings.entries VALUES('assistant.rsql_api_token','removed'),('ai.keep','kept')`.simple();
        for (const [key, value] of [
          ["assistant.rsql_url", cleanupUrl],
          ["assistant.rsql_api_token", "fixture-token"],
          ["assistant.rsql_allowed_targets", ["rsql"]],
        ] as const)
          await sql`INSERT INTO settings.entries(key,value) VALUES(${key},${await encryptValue(value)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
        await sql`INSERT INTO assistant.artifact_databases VALUES(${appId}::uuid,'studio-live')`;
        await sql`INSERT INTO assistant.database_cleanup VALUES('studio-cleanup')`;
        if (kind === "default-targets") await sql`DELETE FROM settings.entries WHERE key='assistant.rsql_allowed_targets'`;
        const networkFetch = services.createAllowedNetworkFetch;
        const network = spyOn(services, "createAllowedNetworkFetch").mockImplementation((allowlist) =>
          networkFetch(allowlist, {
            lookup: async () => [{ address: "127.0.0.1", family: 4 }],
          }),
        );
        restore = () => network.mockRestore();
        chatCallBefore = (await sql`SELECT to_jsonb(c)-'artifact_id' AS row FROM assistant.capability_calls c WHERE id=${callId}::uuid`)[0]
          .row;
        secretBefore = (await sql`SELECT to_jsonb(s)-'resource_id' AS row FROM assistant.http_secrets s WHERE resource_id IS NULL`)[0].row;
      }
      const histories = [
        "artifact_agent_calls",
        "artifact_agent_approvals",
        "artifact_client_calls",
        "capability_calls",
        "http_calls",
        "artifact_machine_runs",
        "artifact_checks",
        "chat_presentations",
      ];
      const before = new Map<string, unknown>();
      if (kind !== "fresh")
        for (const table of histories) before.set(table, [...(await sql.unsafe(`SELECT to_jsonb(t) AS row FROM assistant.${table} t`))]);
      if (kind !== "fresh") {
        await expect(migrateAssistant()).rejects.toThrow("namespace cleanup failed");
        expect((await sql`SELECT count(*)::int AS n FROM assistant.artifacts`)[0].n).toBe(1);
        expect((await sql`SELECT count(*)::int AS n FROM assistant.artifact_databases`)[0].n).toBe(1);
        expect((await sql`SELECT count(*)::int AS n FROM settings.entries WHERE key='assistant.rsql_api_token'`)[0].n).toBe(1);
        removed.length = 0;
        cleanupStatus = 204;
      }
      await migrateAssistant();
      await migrateAssistant();
      expect(removed).toEqual(kind !== "fresh" ? ["/v1/namespaces/studio-live", "/v1/namespaces/studio-cleanup"] : []);
      expect([...(await sql`SELECT * FROM ai.files`)]).toEqual([...beforeFiles]);
      expect([...(await sql`SELECT * FROM approvals.requests WHERE requester_kind='assistant_turn'`)]).toEqual([
        {
          requester_kind: "assistant_turn",
          requester_ref: kind !== "fresh" ? `${chatId}/code/${callId}` : callId,
          requester_title: "Chat request",
          status: "pending",
        },
      ]);
      const [retiredApproval] = await sql`SELECT * FROM approvals.requests WHERE requester_kind='studio_app'`;
      expect(retiredApproval.status).toBe("cancelled");
      expect([
        ...(await sql`SELECT tablename FROM pg_tables WHERE schemaname='assistant' AND tablename IN
        ('artifacts','artifact_revisions','artifact_publications','artifact_access','artifact_projects','artifact_storage','artifact_databases','database_cleanup','artifact_machine_secrets','artifact_machine_rights')`),
      ]).toEqual([]);
      await expect(sql`ALTER TABLE assistant.artifacts ADD COLUMN old_binary text`.execute()).rejects.toThrow();
      if (kind !== "fresh") {
        expect((await sql`SELECT to_jsonb(c) AS row FROM assistant.code_capability_calls c`)[0].row).toEqual(chatCallBefore);
        expect((await sql`SELECT to_jsonb(s) AS row FROM assistant.http_secrets s`)[0].row).toEqual(secretBefore);
        expect(await secrets.decrypt<string>((await sql`SELECT encrypted FROM assistant.http_secrets`)[0].encrypted)).toBe(
          "private-chat-value",
        );
        expect([...(await sql`SELECT call_id FROM assistant.code_agent_calls`)]).toEqual([{ call_id: "chat-call" }]);
        expect([...(await sql`SELECT message,decision,remember FROM assistant.code_agent_approvals`)]).toEqual([
          { message: "Keep this decision", decision: true, remember: { toolName: "demo.write" } },
        ]);
        expect((await sql`SELECT count(*)::int AS n FROM assistant.code_client_calls`)[0].n).toBe(1);
        expect((await sql`SELECT id FROM assistant.code_http_calls`)[0].id).toBe(callId);
        expect([...(await sql`SELECT id FROM auth.access`)]).toEqual([{ id: userId }]);
        expect([...(await sql`SELECT * FROM ai.conversation_resource_refs`)]).toEqual([
          { resource_type: "notebooks.note", resource_id: "Note23" },
        ]);
        expect([...(await sql`SELECT * FROM ai.project_resource_refs`)]).toEqual([
          { resource_type: "notebooks.note", resource_id: "Note23" },
        ]);
        expect([...(await sql`SELECT * FROM settings.entries`)]).toEqual([{ key: "ai.keep", value: "kept" }]);
        expect(retiredApproval.requester_title).toBe("Retired title");
        for (const table of histories) {
          expect([...(await sql.unsafe(`SELECT to_jsonb(t) AS row FROM assistant.${table} t`))]).toEqual(before.get(table) as unknown[]);
          await expect(sql.unsafe(`DELETE FROM assistant.${table}`).execute()).rejects.toThrow("read-only");
        }
        // Include referencing tables so Postgres reaches the write fence instead of its FK precheck.
        await expect(sql.unsafe(`TRUNCATE ${histories.map((table) => `assistant.${table}`).join(",")}`).execute()).rejects.toThrow(
          "read-only",
        );
        // Studio deletion never cascaded into history; the original chat/account lifecycle still applies.
        await sql`DELETE FROM ai.conversations WHERE id=${chatId}::uuid`;
        expect((await sql`SELECT count(*)::int AS n FROM assistant.artifact_agent_calls`)[0].n).toBe(0);
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
        expect((await sql`SELECT count(*)::int AS n FROM assistant.capability_calls`)[0].n).toBe(0);
        expect((await sql`SELECT count(*)::int AS n FROM assistant.artifact_checks`)[0].n).toBe(0);
        expect((await sql`SELECT count(*)::int AS n FROM assistant.http_secrets`)[0].n).toBe(0);
      }
    } finally {
      restore?.();
      await server.stop(true);
      await database.drop();
    }
  });
});
