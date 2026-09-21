import { expect, test } from "bun:test";
import { aiChatTasks, aiConversations, createAiShortId } from "@k2b/cloud/ai";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { agentHost } from "./agent-host";
import { HttpPrepare } from "./http-contracts";
import { httpService } from "./http-service";
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
      const context = { ...testIdentity(userId), conversationId: conversation.id, locale: "en", signal: new AbortController().signal };
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
          'export default()=>{globalThis.marker="background";return {answer:42,process:typeof process};}',
          "same-call-id",
        ),
        run(foreground, "export default()=>({marker:globalThis.marker??null})", "same-call-id"),
      ]);
      expect(background).toMatchObject({ status: "done", result: { status: "ready", output: '{"answer":42,"process":"undefined"}' } });
      expect(interactive).toMatchObject({ status: "done", result: { status: "ready", output: '{"marker":null}' } });
      const denied = await run(
        delivered.turnId,
        'export default async()=>{try {await http.fetch("https://example.com/"); return "unexpected";} catch(e) {return String(e);}}',
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
});
