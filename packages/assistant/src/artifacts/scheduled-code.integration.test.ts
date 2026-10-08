import { expect, spyOn, test } from "bun:test";
import { aiChatTasks, aiConversations, createAiShortId } from "@k2b/cloud/ai";
import { sql } from "bun";
import { databaseSuite, requireInfraUrl, testFor } from "../../../../scripts/fixtures/test-infra";
import { app } from "../config";
import { agentHost, hostFetch } from "./agent-host";
import { artifactDatabase } from "./database";
import { appChecks } from "./html/check-service";
import { HttpPrepare } from "./http-contracts";
import { httpService } from "./http-service";
import { artifacts } from "./service";
import { testIdentity } from "./test-identity";

// Uses the production schemas prepared by `bun run test --integration`.
databaseSuite()("Scheduled Code Mode", () => {
  test("runs with a real task mandate alongside a foreground turn and fails closed after revocation", async () => {
    const previousOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://127.0.0.1:1"; // No capability calls in this test.
    const userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,${userId},'local','user','Scheduled code test')`;
    const conversation = await aiConversations.createConversation({ ownerUserId: userId, title: "Scheduled code test" });
    try {
      const task = (await aiChatTasks.create({
        userId,
        chatId: conversation.shortId,
        prompt: "Calculate",
        grants: [{ kind: "http", fixedInput: { origin: "https://api.example.com", method: "GET" } }],
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: crypto.randomUUID(),
      }))!;
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: "test",
        runConfig: { kind: "chat", input: "Calculate", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Calculate" }] },
        expectedRevision: task.revision,
      });
      if (!delivered.delivered) throw new Error("Task was not delivered");
      await sql`UPDATE ai.turns SET status='running' WHERE id=${delivered.turnId}::uuid`;
      const foreground = crypto.randomUUID();
      await sql`INSERT INTO ai.turns(id,short_id,conversation_id,status,run_config) VALUES(${foreground}::uuid,${createAiShortId()},${conversation.id}::uuid,'running','{"kind":"chat","input":"Foreground","toolSource":{"kind":"none"}}'::jsonb)`;
      const context = {
        ...testIdentity(userId),
        conversationId: conversation.id,
        locale: "de-DE",
        timeZone: "Europe/Berlin",
        signal: new AbortController().signal,
      };
      const run = async (turnId: string, code: string, callId: string = crypto.randomUUID()) => {
        const input = { turnId, callId, name: "code_run" as const, args: { code } };
        for (let i = 0; i < 240; i++) {
          const result = await agentHost.call(input, context);
          if (result.status === "done" || result.status === "lost") return result;
          await Bun.sleep(250);
        }
        throw new Error("Code host did not complete");
      };
      const [background, interactive] = await Promise.all([
        run(
          delivered.turnId,
          'export default()=>{globalThis.marker="background";return {answer:42,process:typeof process,locale:cloud.locale,timeZone:cloud.timeZone};}',
          "same-call-id",
        ),
        run(foreground, "export default()=>({marker:globalThis.marker??null})", "same-call-id"),
      ]);
      expect(background).toMatchObject({
        status: "done",
        result: { status: "ready", output: '{"answer":42,"process":"undefined","locale":"de-DE","timeZone":"Europe/Berlin"}' },
      });
      expect(interactive).toMatchObject({ status: "done", result: { status: "ready", output: '{"marker":null}' } });
      const denied = await run(
        delivered.turnId,
        'export default async()=>{try {await cloud.http.fetch("https://example.com/"); return "unexpected";} catch(e) {return String(e);}}',
      );
      expect(JSON.stringify(denied)).toContain("access denied");
      const pendingHttp = HttpPrepare.parse({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        scope: { conversationId: conversation.id },
        request: { url: "https://api.example.com/data", method: "GET" },
      });
      await httpService.prepare(pendingHttp, context);
      await sql`UPDATE auth.mandates SET state='revoked',revision=revision+1,revoked_at=now(),revoke_reason='Test revocation' WHERE id=${task.mandateId}::uuid`;
      await expect(run(delivered.turnId, "export default()=>1")).rejects.toThrow("authority changed");
      let sent = false;
      await expect(
        httpService.execute(
          pendingHttp.id,
          true,
          context,
          context.signal,
          async () => {
            sent = true;
            throw new Error("Must not send after revocation");
          },
          async (stored) => {
            expect(stored).toMatchObject(pendingHttp);
            await aiChatTasks.authorizeRuntime({
              mandate: { id: task.mandateId!, revision: task.mandateRevision! },
              kind: "http",
              input: { url: stored.request.url, origin: new URL(stored.request.url).origin, method: stored.request.method },
            });
          },
        ),
      ).rejects.toThrow("access denied");
      expect(sent).toBe(false);
    } finally {
      await agentHost.close();
      if (previousOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = previousOrigin;
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 120_000);

  type Grant = { resourceId: string; operation: "rows.insert" | "export"; table?: string };
  // A real scheduled turn whose mandate holds exactly one database grant.
  async function backgroundCheckStart(userId: string, conversation: { id: string; shortId: string }, grant: Grant) {
    const task = (await aiChatTasks.create({
      userId,
      chatId: conversation.shortId,
      prompt: "Check invoices",
      grants: [{ kind: "database", fixedInput: grant }],
      schedule: { kind: "cron", cron: "0 9 * * *" },
      timezone: "UTC",
    }))!;
    const occurrence = (await aiChatTasks.createOccurrence({
      taskId: task.id,
      scheduledFor: new Date().toISOString(),
      trigger: "manual",
      requestKey: crypto.randomUUID(),
    }))!;
    const delivered = await aiChatTasks.deliverOccurrence({
      occurrenceId: occurrence.id,
      modelProfileId: "test",
      runConfig: { kind: "chat", input: "Check invoices", toolSource: { kind: "none" } },
      userMessage: { role: "user", content: [{ type: "text", text: "Check invoices" }] },
      expectedRevision: task.revision,
    });
    if (!delivered.delivered) throw new Error("Task was not delivered");
    await sql`UPDATE ai.turns SET status='running' WHERE id=${delivered.turnId}::uuid`;
    const context = {
      ...testIdentity(userId),
      conversationId: conversation.id,
      locale: "en",
      timeZone: "UTC",
      signal: new AbortController().signal,
    };
    const session: Parameters<typeof hostFetch>[1] = {
      phase: "running",
      id: crypto.randomUUID(),
      key: delivered.turnId,
      conversationId: conversation.id,
      turnId: delivered.turnId,
      background: true,
      context,
      lastUsed: Date.now(),
      busy: new Set(),
      checks: new Map(),
      checkScopes: new Set(),
      decisions: new Map(),
      capabilityTransport: async () => {
        throw new Error("Unexpected capability");
      },
      host: Promise.resolve({ health: async () => {}, execute: async () => null, call: async () => null, close: async () => {} }),
    };
    try {
      const response = await hostFetch(context, session, "/api/assistant/artifacts/runtime/check/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { id: grant.resourceId }, conversationId: conversation.id }),
      });
      return { response, scopes: [...session.checkScopes] };
    } finally {
      await sql`UPDATE ai.turns SET status='completed' WHERE id=${delivered.turnId}::uuid`;
    }
  }
  const invoices = { entry: "index.html", files: [{ path: "index.html", content: "<main><h1>Invoices</h1></main>" }] };

  test("background checks of an app with a database are refused without an export grant", async () => {
    const userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,${userId},'local','user','Background check test')`;
    const identity = testIdentity(userId);
    const conversation = await aiConversations.createConversation({ ownerUserId: userId, title: "Background check" });
    const namespace = `check-grant-${crypto.randomUUID()}`;
    let resourceId: string | undefined;
    try {
      resourceId = (await artifacts.create({ kind: "app", title: "Invoices", source: invoices }, identity)).id;
      // The grant check only needs a connected mapping; no rsql call happens before the refusal.
      await sql`INSERT INTO assistant.artifact_databases(artifact_id,namespace,connected)
        VALUES((SELECT id FROM assistant.artifacts WHERE short_id=${resourceId}),${namespace},true)`;
      const { response, scopes } = await backgroundCheckStart(userId, conversation, {
        resourceId,
        operation: "rows.insert",
        table: "invoices",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "BACKGROUND_ACCESS_DENIED" });
      expect(scopes).toEqual([]);
      expect(
        await sql<{ id: string }[]>`SELECT a.id FROM assistant.artifacts a JOIN ai.conversations c ON c.id=a.check_conversation_id
          WHERE a.check_scratch AND c.created_by_user_id=${userId}::uuid`,
      ).toEqual([]);
    } finally {
      if (resourceId) await artifacts.remove(resourceId, identity);
      await sql`DELETE FROM assistant.database_cleanup WHERE namespace=${namespace}`;
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 60_000);

  testFor("rsql")(
    "background checks copy an app database under an export grant",
    async () => {
      const userId = crypto.randomUUID();
      await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES(${userId}::uuid,${userId},'local','user','Background check test')`;
      const identity = testIdentity(userId);
      const conversation = await aiConversations.createConversation({ ownerUserId: userId, title: "Background check" });
      const settings = spyOn(app.settings, "get").mockImplementation(
        async (key) =>
          ({
            "assistant.storage_total_mib": 250,
            "assistant.storage_file_mib": 50,
            "assistant.rsql_url": requireInfraUrl("rsql"),
            "assistant.rsql_api_token": "artifact-test-only",
          })[key],
      );
      let resourceId: string | undefined;
      const scopes: string[] = [];
      try {
        resourceId = (await artifacts.create({ kind: "app", title: "Invoices", source: invoices }, identity)).id;
        await artifactDatabase.connect(resourceId, identity);
        const started = await backgroundCheckStart(userId, conversation, { resourceId, operation: "export" });
        scopes.push(...started.scopes);
        expect(started.response.status).toBe(200);
        expect(await started.response.json()).toMatchObject({ artifactId: resourceId, scopeId: expect.any(String) });
        expect(scopes).toHaveLength(1);
      } finally {
        for (const scope of scopes) await appChecks.discard(scope, identity);
        if (resourceId) {
          const [connected] = await sql<{ namespace: string }[]>`SELECT d.namespace FROM assistant.artifact_databases d
            JOIN assistant.artifacts a ON a.id=d.artifact_id WHERE a.short_id=${resourceId}`;
          await artifacts.remove(resourceId, identity);
          if (connected) await artifactDatabase.deleteQueuedNamespace(connected.namespace);
        }
        settings.mockRestore();
        await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
    60_000,
  );
});
