import { afterAll, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { closeMigratedDatabaseTemplate, migratedDatabaseTemplate } from "../../../../scripts/fixtures/test-database-template";
import {
  databaseSuite,
  initializeTestPlatform,
  requireDatabaseUrl,
  testInfra,
  useMigratedDatabase,
} from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import * as registry from "../_internal/registry";
import { capabilityCallDigest, capabilityValueDigest } from "../capabilities/calls";
import { NormalizedCapabilityCallSchema } from "../contracts/capabilities";
import { approvalReviewDigest, approvals } from "../services/approvals";
import { projectMigratedCapabilityCalls } from "./capability-targets-history";
import { migrateAiCapabilityTargets } from "./capability-targets-migrate";
import { buildBlocksFromMessages } from "./protocol";
import { aiConversations } from "./store";
import { loadAiStreamState } from "./stream";

// A direct single-file run has no runner bootstrap. Prepare the cold production
// schema before timing migration assertions; each test still gets its own clone.
if (testInfra.database) {
  afterAll(closeMigratedDatabaseTemplate);
  await migratedDatabaseTemplate(requireDatabaseUrl());
}

databaseSuite()("capability target upgrade with existing Assistant data", () => {
  test("preserves approvals, old history, and every unrelated data row; runs twice without changes", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const database = await useMigratedDatabase("capability_targets");
    const db = new SQL(database.url);
    const appLookup = spyOn(registry, "getApp").mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-test-pipe",
      description: "Fictional upgrade fixture",
      baseUrl: `http://${id}.example.test:3000`,
      routes: [`/api/${id}`],
      access: { kind: "signedIn" },
    }));
    try {
      // Reconstruct the previous release's schema, so the first invocation really discovers old rows.
      await db`ALTER TABLE ai.pending_actions DROP COLUMN capability_target_version`.simple();
      const [user] = await db<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,mail)
        VALUES('fictional-target-upgrade','local','user','fictional-target-upgrade@example.test') RETURNING id`;
      const userId = user!.id;
      const [chat] = await db<{ id: string }[]>`INSERT INTO ai.conversations(short_id,created_by_user_id,title)
        VALUES(${testShortId()},${userId}::uuid,'Fictional old chat') RETURNING id`;
      const chatId = chat!.id;
      const [historyTurn] = await db<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status,run_config)
        VALUES(${testShortId()},${chatId}::uuid,'completed','{"kind":"chat","input":"Old format"}') RETURNING id`;
      const originalMessage = {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            id: "old-call",
            name: "spaces__action__task_dot_create",
            args: { spaceId: "SpaceA", obsolete: ["stored", "unchanged"] },
          },
        ],
      };
      await db`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,loop_id)
        VALUES(${testShortId()},${chatId}::uuid,1,'message','assistant',${JSON.stringify(originalMessage)}::text::jsonb,${historyTurn!.id})`;
      await db`INSERT INTO ai.tool_calls(turn_id,conversation_id,call_id,tool_name,status)
        VALUES(${historyTurn!.id}::uuid,${chatId}::uuid,'old-call','spaces.task.create','completed')`;
      const [settled] = await db<
        { id: string }[]
      >`INSERT INTO ai.pending_actions(turn_id,conversation_id,call_id,kind,tool_name,args,approval_scope,status)
        VALUES(${historyTurn!.id}::uuid,${chatId}::uuid,'old-settled-call','custom_approval','spaces.task.create',
          ${JSON.stringify(originalMessage.content[0]!.args)}::text::jsonb,'spaces.task.create','resolved') RETURNING id`;
      await db`INSERT INTO ai.files(conversation_id,path,bytes,media_type,size,origin)
        VALUES(${chatId}::uuid,'fictional.txt',decode('68656c6c6f','hex'),'text/plain',5,'user')`;
      await db`INSERT INTO ai.projects(short_id,name) VALUES(${testShortId()},'Fictional project')`;
      await db`INSERT INTO ai.memories(short_id,user_id,kind,content) VALUES(${testShortId()},${userId}::uuid,'fact','Fictional memory')`;
      await db`INSERT INTO ai.skills(short_id,name,description,instructions)
        VALUES(${testShortId()},'fictional-upgrade','Fictional Skill','Keep the fictional fixture.')`;
      await db`INSERT INTO ai.tool_approval_preferences(actor_user_id,tool_name,approval_scope)
        VALUES(${userId}::uuid,'spaces.task.create','spaces.task.create')`;

      const pending: { id: string; turnId: string; approvalId: string; callId: string; chatId: string }[] = [];
      for (const [index, [appId, capabilityId, args]] of (
        [
          ["spaces", "task.create", { spaceId: "SpaceA", title: "Fictional reviewed task" }],
          ["spaces", "task.create", { title: "Missing container" }],
          ["weather", "location.create", { name: "Fictional weather place", latitude: 50, longitude: 8 }],
          ["spaces", "task.create", { spaceId: "SpaceA", title: "Fictional already approved task" }],
          ["spaces", "task.create", { title: "Already approved without a container" }],
        ] as const
      ).entries()) {
        const [approvalChat] =
          index === 0
            ? [{ id: chatId }]
            : await db<{ id: string }[]>`INSERT INTO ai.conversations(short_id,created_by_user_id,title)
          VALUES(${testShortId()},${userId}::uuid,'Another fictional approval chat') RETURNING id`;
        const pendingChatId = approvalChat!.id;
        const [turn] = await db<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status,run_config)
          VALUES(${testShortId()},${pendingChatId}::uuid,'waiting_for_action','{"kind":"chat","input":"Fictional request"}') RETURNING id`;
        const callId = `pending-${index}-approval-0`;
        await db`UPDATE ai.turns SET live_blocks=${JSON.stringify([
          { id: "old-text", kind: "text", text: "Stored fictional text" },
          {
            id: `pending-${index}`,
            kind: "tool",
            callId: `pending-${index}`,
            name: "spaces.task.create",
            status: "awaiting_approval",
            approval: { allowAlways: true },
          },
        ])}::text::jsonb WHERE id=${turn!.id}::uuid`;
        const [approval] = await db<
          { id: string }[]
        >`INSERT INTO approvals.requests(app_id,action,requester_kind,requester_ref,requester_app_id,
          subject_id,approver_user_id,approver_auth_epoch,assurance,sentence,args_digest,review_digest,expires_at)
          VALUES(${appId},${capabilityId},'assistant_turn',${`${turn!.id}/${callId}`},'assistant',${userId}::uuid,${userId}::uuid,
            (SELECT auth_epoch FROM auth.users WHERE id=${userId}::uuid),'standard','Create the fictional task?',
            ${capabilityValueDigest(args)},${approvalReviewDigest(null)},now()+interval '1 day') RETURNING id`;
        const [action] = await db<
          { id: string }[]
        >`INSERT INTO ai.pending_actions(turn_id,conversation_id,call_id,kind,tool_name,args,approval_scope,approval_id)
          VALUES(${turn!.id}::uuid,${pendingChatId}::uuid,${callId},'custom_approval',${`${appId}.${capabilityId}`},${JSON.stringify(args)}::text::jsonb,
            ${`${appId}.${capabilityId}`},${approval!.id}::uuid) RETURNING id`;
        pending.push({ id: action!.id, turnId: turn!.id, approvalId: approval!.id, callId, chatId: pendingChatId });
        if (index >= 3) {
          await db`UPDATE approvals.requests SET status='approved', decided_at=now(), decided_via='web_session' WHERE id=${approval!.id}::uuid`;
          await db`UPDATE ai.pending_actions SET status='resolved', resolved_event='{"type":"approval_response","approved":true}'::jsonb,
            resolved_at=now() WHERE id=${action!.id}::uuid`;
        }
      }

      // Real stored history must retain its bytes while the read path adds the notice.
      for (const seq of [1, 2, 3]) {
        await db`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,loop_id,compacted_at)
          VALUES(${testShortId()},${pending[1]!.chatId}::uuid,${seq},'message','assistant',
            ${JSON.stringify(originalMessage)}::text::jsonb,${pending[1]!.turnId},
            ${seq === 3 ? "2026-10-31T00:00:00Z" : null}::timestamptz)`;
      }

      // PostgreSQL's binary row serialization includes JSON, bytea, timestamps, nulls, and generated columns.
      const untouched = ["conversations", "messages", "tool_calls", "files", "projects", "memories", "skills", "tool_approval_preferences"];
      const bytes = async (tables: string[]) =>
        Promise.all(
          tables.map(async (table) => {
            const rows = await db.unsafe<{ bytes: string }[]>(
              `SELECT encode(record_send(row),'hex') AS bytes FROM ai.${table} row ORDER BY id`,
            );
            return [table, rows.map((row) => row.bytes)] as const;
          }),
        );
      const before = await bytes(untouched);
      await migrateAiCapabilityTargets(db);
      expect(await bytes(untouched)).toEqual(before);
      expect(
        await db<
          { args: unknown; status: string; capability_target_version: number }[]
        >`SELECT args,status,capability_target_version FROM ai.pending_actions WHERE id=${settled!.id}::uuid`,
      ).toEqual([{ args: originalMessage.content[0]!.args, status: "resolved", capability_target_version: 0 }]);

      const [mapped] = await db<
        { args: unknown; status: string; args_digest: string }[]
      >`SELECT action.args,action.status,request.args_digest
        FROM ai.pending_actions action JOIN approvals.requests request ON request.id=action.approval_id WHERE action.id=${pending[0]!.id}::uuid`;
      const approvedCall = NormalizedCapabilityCallSchema.parse(mapped!.args);
      expect(mapped!.status).toBe("pending");
      expect(mapped!.args_digest).toBe(capabilityCallDigest(approvedCall));
      expect(approvedCall.target).toEqual({ type: "spaces.space", id: "SpaceA" });
      const [appWide] = await db<{ args: unknown; args_digest: string }[]>`SELECT action.args,request.args_digest
        FROM ai.pending_actions action JOIN approvals.requests request ON request.id=action.approval_id WHERE action.id=${pending[2]!.id}::uuid`;
      const appWideCall = NormalizedCapabilityCallSchema.parse(appWide!.args);
      expect(appWideCall).toEqual({
        capability: "weather.location.create",
        target: null,
        refs: {},
        input: { name: "Fictional weather place", latitude: 50, longitude: 8 },
      });
      expect(appWide!.args_digest).toBe(capabilityCallDigest(appWideCall));
      const upgradedFrames = await projectMigratedCapabilityCalls(db, chatId, pending[0]!.turnId, [
        {
          seq: 1,
          kind: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "pending-0",
                name: "spaces__action__task_dot_create",
                args: { spaceId: "SpaceA", title: "Fictional reviewed task" },
              },
            ],
          },
        },
      ]);
      expect(upgradedFrames[0]!.message).toMatchObject({ content: [{ args: { space: "SpaceA", title: "Fictional reviewed task" } }] });
      expect(
        (await db.begin((tx) => approvals.decide(pending[0]!.approvalId, { approved: true }, { userId, via: "web_session" }, tx))).ok,
      ).toBe(true);
      expect(
        await db.begin((tx) =>
          approvals.consume(
            pending[0]!.approvalId,
            {
              input: approvedCall,
              review: null,
              requester: { kind: "assistant_turn", ref: `${pending[0]!.turnId}/${pending[0]!.callId}` },
            },
            tx,
          ),
        ),
      ).toEqual({ ok: true });
      const [alreadyApproved] = await db<
        { args: unknown; status: string }[]
      >`SELECT args,status FROM ai.pending_actions WHERE id=${pending[3]!.id}::uuid`;
      expect(alreadyApproved!.status).toBe("resolved");
      const approvedBeforeUpgrade = NormalizedCapabilityCallSchema.parse(alreadyApproved!.args);
      expect(approvedBeforeUpgrade.target).toEqual({ type: "spaces.space", id: "SpaceA" });
      expect(
        await db.begin((tx) =>
          approvals.consume(
            pending[3]!.approvalId,
            {
              input: approvedBeforeUpgrade,
              review: null,
              requester: { kind: "assistant_turn", ref: `${pending[3]!.turnId}/${pending[3]!.callId}` },
            },
            tx,
          ),
        ),
      ).toEqual({ ok: true });
      expect(
        await db<{ status: string; message: string }[]>`SELECT status,message FROM ai.pending_actions WHERE id=${pending[4]!.id}::uuid`,
      ).toEqual([{ status: "aborted", message: "Bitte neu anfragen" }]);
      const [unmapped] = await db<
        { status: string; message: string }[]
      >`SELECT status,message FROM ai.pending_actions WHERE id=${pending[1]!.id}::uuid`;
      expect(unmapped).toEqual({ status: "aborted", message: "Bitte neu anfragen" });
      const [cancelled] = await db<{ status: string }[]>`SELECT status FROM approvals.requests WHERE id=${pending[1]!.approvalId}::uuid`;
      expect(cancelled!.status).toBe("cancelled");
      const [abortedTurn] = await db<{ live_blocks: unknown }[]>`SELECT live_blocks FROM ai.turns WHERE id=${pending[1]!.turnId}::uuid`;
      expect(abortedTurn!.live_blocks).toEqual([
        { id: "old-text", kind: "text", text: "Stored fictional text" },
        {
          id: "pending-1",
          kind: "tool",
          callId: "pending-1",
          name: "spaces.task.create",
          status: "failed",
          isError: true,
          approved: false,
          result: { error: "Bitte neu anfragen" },
        },
        { id: "capability-target-migration", kind: "text", text: "Bitte neu anfragen" },
      ]);
      const displayed = await aiConversations.listMessages({ conversationId: pending[1]!.chatId });
      expect(displayed).toHaveLength(3);
      expect(displayed.map((message) => message.meta?.turnError)).toEqual([
        { code: "capability_changed" },
        { code: "capability_changed" },
        { code: "capability_changed" },
      ]);
      expect(displayed.map((message) => message.loopDoneReason)).toEqual([null, "aborted", null]);
      expect(displayed.map((message) => message.message)).toEqual([originalMessage, originalMessage, originalMessage]);
      // A page without the final non-compacted assistant must not invent another turn end.
      const earlier = await aiConversations.listMessagesPage({ conversationId: pending[1]!.chatId, limit: 1, beforeSeq: 2 });
      expect(earlier.messages).toHaveLength(1);
      expect(earlier.messages[0]).toMatchObject({ loopDoneReason: null, meta: { turnError: { code: "capability_changed" } } });
      const final = await aiConversations.listMessagesPage({ conversationId: pending[1]!.chatId, limit: 1, beforeSeq: 3 });
      expect(final.messages).toHaveLength(1);
      expect(final.messages[0]).toMatchObject({ loopDoneReason: "aborted", meta: { turnError: { code: "capability_changed" } } });
      const conversation = await aiConversations.getConversation({ conversationId: pending[1]!.chatId });
      const state = await loadAiStreamState(conversation!);
      expect(state.messages).toHaveLength(3);
      expect(state.messages[1]).toMatchObject({ loopDoneReason: "aborted", meta: { turnError: { code: "capability_changed" } } });

      const meter = await meterSql();
      try {
        // Ordinary and empty history need only the message query (+ the nonempty page's older-row check).
        expect(
          await meter.during(async () => {
            const messages = await aiConversations.listMessages({ conversationId: chatId });
            expect(messages).toHaveLength(1);
            expect(messages[0]!.meta?.turnError).toBeUndefined();
          }),
        ).toHaveLength(1);
        expect(
          await meter.during(async () => {
            const page = await aiConversations.listMessagesPage({ conversationId: chatId });
            expect(page.messages).toHaveLength(1);
            expect(page.messages[0]!.meta?.turnError).toBeUndefined();
          }),
        ).toHaveLength(2);
        expect(
          await meter.during(async () => {
            expect(await aiConversations.listMessages({ conversationId: pending[2]!.chatId })).toEqual([]);
          }),
        ).toHaveLength(1);
        expect(
          await meter.during(async () => {
            expect(await aiConversations.listMessagesPage({ conversationId: pending[2]!.chatId })).toEqual({
              messages: [],
              hasMore: false,
            });
          }),
        ).toHaveLength(1);
      } finally {
        await meter.close();
      }
      expect(buildBlocksFromMessages([{ seq: 1, message: originalMessage }])[0]).toMatchObject({ args: originalMessage.content[0]!.args });

      const allChangedTables = [...untouched, "pending_actions", "turns"];
      const first = await bytes(allChangedTables);
      const mandatesFirst = await db`SELECT encode(record_send(row),'hex') AS bytes FROM auth.mandates row ORDER BY id`;
      const approvalsFirst = await db`SELECT encode(record_send(row),'hex') AS bytes FROM approvals.requests row ORDER BY id`;
      const [auditBefore] = await db<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM audit.events WHERE action = 'ai.approval.targets.migrate'`;
      expect(auditBefore!.count).toBe(pending.length);
      await migrateAiCapabilityTargets(db);
      expect(await bytes(allChangedTables)).toEqual(first);
      expect(await db`SELECT encode(record_send(row),'hex') AS bytes FROM auth.mandates row ORDER BY id`).toEqual(mandatesFirst);
      expect(await db`SELECT encode(record_send(row),'hex') AS bytes FROM approvals.requests row ORDER BY id`).toEqual(approvalsFirst);
      expect(
        await db<{ count: number }[]>`SELECT count(*)::int AS count FROM audit.events WHERE action = 'ai.approval.targets.migrate'`,
      ).toEqual([auditBefore!]);
    } finally {
      appLookup.mockRestore();
      await db.close();
      process.env.DATABASE_URL = originalDatabaseUrl;
      await initializeTestPlatform();
      await database.drop();
    }
  });
});
