import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as cloudAi from "@k2b/cloud/ai";
import { AI_WEBSITE_APPROVAL_TOOL, aiConversations, aiProjects, forgetAiToolApproval, rememberAiToolApproval } from "@k2b/cloud/ai";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { secrets } from "@k2b/cloud/services";
import { approvalReviewDigest, approvals, migrateApprovals } from "@k2b/cloud/services/approvals";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { createAssistantPlaceFixture, PLACE_FIXTURE_APP_ID, PLACE_FIXTURE_TYPE } from "../../../../scripts/fixtures/assistant-place";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { createAgentHost } from "./agent-host";
import { createChatCodeServiceRoutes } from "./api";
import { runtimeCapabilities } from "./capability-runtime";
import * as chatAccess from "./chat-access";
import { HttpPrepare } from "./http-contracts";
import { httpService as chatHttpService, HttpError, httpService } from "./http-service";
import { migrateChatCode } from "./migrate";
import { runChatRunnerFixture } from "./runner-code.test-fixture";
import * as runnerHost from "./runner-code-host";
import { testIdentity } from "./test-identity";

function checkConversation(conversationId: string, userId: string) {
  return {
    id: conversationId,
    shortId: "abc234",
    title: "Check",
    titleSource: "user" as const,
    description: "",
    descriptionSource: "user" as const,
    keywords: [],
    pinnedAt: null,
    done: null,
    isDone: false,
    lastUsedAt: "2026-10-22T00:00:00.000Z",
    archivedAt: null,
    runStatus: "idle" as const,
    runError: null,
    unreadCompletion: false,
    projectId: null,
    draft: { content: [], revision: 1, updatedAt: null },
    createdByUserId: userId,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}

databaseSuite()("Assistant chat runner persistence", () => {
  const owner = testIdentity("00000000-0000-4000-8000-000000000001");
  const stranger = testIdentity("00000000-0000-4000-8000-000000000004");
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("assistant_chat_host");
    await sql`CREATE SCHEMA auth;
      CREATE TYPE auth.permission_level AS ENUM ('none','read','write','admin');
      CREATE TABLE auth.users(id uuid PRIMARY KEY,display_name text DEFAULT 'Test',uid text DEFAULT 'test',avatar_hash text,auth_epoch bigint NOT NULL DEFAULT 0,account_expires timestamptz,provider text DEFAULT 'local',profile text DEFAULT 'user',admin boolean DEFAULT false);
      CREATE TABLE auth.groups(id uuid PRIMARY KEY,name text,provider text);
      CREATE TABLE auth.user_groups_v2(user_id uuid,group_id uuid);
      CREATE TABLE auth.ipa_user_effective_groups(user_id uuid,group_name text);
      CREATE TABLE auth.group_groups_v2(parent_group_id uuid,child_group_id uuid);
      CREATE TABLE auth.access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,group_id uuid,service_account_id uuid,authenticated_only boolean DEFAULT false,permission auth.permission_level,created_at timestamptz DEFAULT now());
      CREATE SCHEMA ai;
      CREATE TABLE ai.conversations(id uuid PRIMARY KEY,created_by_user_id uuid,archived_at timestamptz);
      CREATE TABLE ai.projects(id uuid PRIMARY KEY,short_id text UNIQUE,name text,description text DEFAULT '',icon text DEFAULT '',instructions text DEFAULT '',default_model jsonb,revision integer DEFAULT 1,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE ai.project_access(project_id uuid,access_id uuid);
      CREATE TABLE ai.turns(id uuid PRIMARY KEY,status text,conversation_id uuid,run_config jsonb);
      CREATE TABLE ai.tool_approval_preferences(id uuid DEFAULT gen_random_uuid(),actor_user_id uuid,tool_name text,approval_scope text,
        conversation_id uuid REFERENCES ai.conversations(id) ON DELETE CASCADE,created_at timestamptz DEFAULT now(),last_used_at timestamptz,expires_at timestamptz);
      CREATE UNIQUE INDEX ai_tool_approval_preferences_reach ON ai.tool_approval_preferences(actor_user_id,tool_name,approval_scope,conversation_id) NULLS NOT DISTINCT;
      CREATE TABLE ai.tool_calls(request_id text,conversation_id uuid,turn_id uuid,location text,call_id text,tool_name text,status text,started_at timestamptz,UNIQUE(turn_id,call_id));
      CREATE SCHEMA audit;
      CREATE TABLE audit.events(id bigserial PRIMARY KEY,created_at timestamptz DEFAULT now(),action text,outcome text,
        actor_user_id uuid,actor_uid text,actor_provider text,actor_roles text[],target_type text,target_id text,target_label text,
        target_provider text,reason text,error_code text,error_message text,request_id text,metadata jsonb)`.simple();
    await sql`INSERT INTO auth.users(id) VALUES(${owner.user.id}::uuid),(${stranger.user.id}::uuid)`;
    await migrateApprovals();
    await migrateChatCode();
  });
  afterAll(async () => {
    await database?.drop();
  });
  test("server-owned code survives caller detachment, deduplicates calls and never replays a lost host", async () => {
    // The disposable Assistant database has no Core runner mailbox. Replace only
    // that transport with the real Runner dispatch/compiler fixture.
    const transport = spyOn(cloudAi, "createCodeCapabilityTransport").mockReturnValue(async () => {
      throw new Error("Unexpected Core capability dispatch");
    });
    const createHost = runnerHost.createRunnerCodeHost;
    const start = spyOn({ run: runChatRunnerFixture }, "run");
    const runner = spyOn(runnerHost, "createRunnerCodeHost").mockImplementation((options) => createHost({ ...options, start }));
    const chatHost = createAgentHost({ createHost: (options) => createHost({ ...options, start }) });
    const host = chatHost;
    const conversationId = crypto.randomUUID(),
      turnId = crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversationId}::uuid,${owner.user.id}::uuid)`;
    // The host reads the turn's run_config through its conversation to detect task-scoped grants.
    await sql`INSERT INTO ai.turns(id,status,conversation_id) VALUES(${turnId}::uuid,'running',${conversationId}::uuid)`;
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) =>
      request.ownerUserId !== owner.user.id
        ? null
        : {
            id: conversationId,
            shortId: "abc234",
            title: "Host test",
            titleSource: "user",
            description: "",
            descriptionSource: "user",
            keywords: [],
            pinnedAt: null,
            done: null,
            isDone: false,
            lastUsedAt: "2026-09-14T00:00:00.000Z",
            archivedAt: null,
            runStatus: "running",
            runError: null,
            unreadCompletion: false,
            projectId: null,
            draft: { content: [], revision: 1, updatedAt: null },
            createdByUserId: owner.user.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
    );
    const activeTurn = {
      id: turnId,
      shortId: "abc345",
      conversationId,
      status: "running" as const,
      attempt: 1,
      modelId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    const turn = spyOn(aiConversations, "getActiveTurn").mockResolvedValue({
      turn: activeTurn,
      liveBlocks: [],
      liveSeq: 1,
      actionWaitMs: 0,
      waitingSince: null,
    });
    // authorizeCodeExecution reads the turn and its run config; a plain chat turn carries neither mandate nor background.
    // getTurn follows the active-turn stub so cancelling the turn below is seen by both readers.
    const getTurn = spyOn(aiConversations, "getTurn").mockImplementation(
      async () => (await aiConversations.getActiveTurn({ conversationId }))?.turn ?? null,
    );
    const runConfig = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
      kind: "chat",
      input: "Run",
      toolSource: { kind: "none" },
    });
    const abort = new AbortController();
    const context = { ...owner, conversationId, locale: "en", timeZone: "UTC", signal: abort.signal };
    const call = {
      turnId,
      callId: "server-run",
      name: "code_run" as const,
      args: { code: "export default () => ({answer:42,serverProcess:typeof process})" },
    };
    // Polls the durable call record until it settles; the bound is wall-clock,
    // not an iteration count, so slow polls do not shorten it (#37).
    const wait = async (input: Parameters<typeof host.call>[0], ready?: (state: Awaited<ReturnType<typeof host.call>>) => boolean) => {
      const deadline = Date.now() + 10_000;
      let last: Awaited<ReturnType<typeof host.call>> | undefined;
      while (Date.now() < deadline) {
        last = await host.call(input, { ...context, signal: new AbortController().signal });
        if (ready?.(last) || (last.status !== "running" && last.status !== "busy")) return last;
        await Bun.sleep(25);
      }
      throw new Error(`Managed host call ${input.callId} did not settle: ${JSON.stringify(last)}`);
    };
    try {
      const starts = await Promise.all([host.call(call, context), host.call(call, context)]);
      expect(starts.every((result) => ["running", "busy"].includes(result.status))).toBe(true);
      abort.abort(); // Detaching the HTTP caller must not terminate the owned execution.
      const observers = await Promise.all(Array.from({ length: 8 }, () => wait(call)));
      expect(observers.map((result) => result.status)).toEqual(Array.from({ length: 8 }, () => "done"));
      const result = observers[0]!;
      expect(result).toMatchObject({ status: "done", result: { status: "ready", output: '{"answer":42,"serverProcess":"undefined"}' } });
      expect(await wait(call)).toEqual(result);
      expect(start).toHaveBeenCalledTimes(1);
      const syntax = await wait({ ...call, callId: "syntax-error", args: { code: "export default () => { const broken = ; }" } });
      expect(syntax).toMatchObject({ status: "done", result: { failed: true, error: expect.stringContaining("Unexpected") } });
      expect(JSON.stringify(syntax)).not.toContain("artifact request failed");
      await expect(host.call({ ...call, args: { code: "export default ()=>43" } }, context)).rejects.toThrow("input changed");
      await expect(host.call(call, { ...context, ...stranger })).rejects.toThrow();
      const inspect = { ...call, name: "code_inspect" as const, callId: "server-inspect", args: { runId: call.callId } };
      expect(await wait(inspect)).toMatchObject({ status: "done", result: { runId: call.callId, status: "ready" } });
      let sent = 0;
      const http = spyOn(chatHttpService, "execute").mockImplementation(async (id, approved) => {
        // Settle the stored call like the service does, so a run with many requests stays within the pending budget.
        await sql`UPDATE assistant.code_http_calls SET status=${approved ? "completed" : "denied"},encrypted='' WHERE id=${id}::uuid`;
        // A declined request never goes out.
        if (!approved) throw new HttpError("HTTP_DENIED");
        sent++;
        return { status: 200, headers: { "content-type": "application/json" }, body: btoa('{"ok":true}') };
      });
      try {
        const network = {
          ...call,
          callId: "approved-http",
          args: { code: 'export default async()=>await (await cloud.http.fetch("https://example.com/data")).json()' },
        };
        let approval: { id: string } | undefined;
        for (let i = 0; i < 200 && !approval; i++) {
          const state = await host.call(network, context);
          approval = state.approvals[0];
          if (!approval) await Bun.sleep(25);
        }
        expect(approval).toBeDefined();
        expect(sent).toBe(0);
        await host.call({ ...network, decision: { id: approval!.id, approved: true } }, context);
        expect(await wait(network)).toMatchObject({ status: "done", result: { output: '{"ok":true}' } });
        expect(await wait(network)).toMatchObject({ status: "done" });
        expect(sent).toBe(1);
        // A website approval for this chat lets later exact-origin reads through, each with a receipt, and nothing else.
        const runCode = async (callId: string, code: string) => {
          const input = { ...call, callId, args: { code } };
          for (let i = 0; i < 400; i++) {
            const state = await host.call(input, context);
            const pending = state.approvals.find((approval) => approval.decision === null);
            if (pending || state.status === "done") return { input, state, pending };
            await Bun.sleep(25);
          }
          throw new Error(`Code call ${callId} neither asked nor finished`);
        };
        const decline = async (run: Awaited<ReturnType<typeof runCode>>) => {
          await host.call({ ...run.input, decision: { id: run.pending!.id, approved: false } }, context);
          return wait(run.input);
        };
        const fetchCode = (url: string, init = "{}") =>
          `export default async()=>(await cloud.http.fetch(${JSON.stringify(url)},${init})).status`;
        const website = { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: "https://example.com", always: false };
        runConfig.mockResolvedValue({ kind: "chat", input: "Run", toolSource: { kind: "none" }, signedInSession: true });
        const first = await runCode("website-first", fetchCode("https://example.com/data"));
        expect(first.pending).toMatchObject({ remember: website });
        // A read says that it reads, not that it may change data or incur charges.
        expect(first.pending?.message).toContain("This request reads data from example.com.");
        expect(first.pending?.message).not.toContain("may change data");
        await rememberAiToolApproval({ actorUserId: owner.user.id }, { ...website, conversationId });
        await host.call({ ...first.input, decision: { id: first.pending!.id, approved: true } }, context);
        expect(await wait(first.input)).toMatchObject({ status: "done", receipts: [] });
        const allowed = await runCode("website-allowed", fetchCode("https://example.com/data?symbols=NVDA,AAPL"));
        expect(allowed.pending).toBeUndefined();
        expect(allowed.state).toMatchObject({
          status: "done",
          approvals: [],
          receipts: [{ method: "GET", url: "https://example.com/data?symbols=NVDA,AAPL" }],
        });
        // Receipts grow with every request, so each answer carries one page of them and the result follows the last.
        const many = await runCode(
          "website-many",
          'export default async()=>{for(let i=0;i<52;i++)await cloud.http.fetch("https://example.com/data?page="+i);return "ok"}',
        );
        expect(many.pending).toBeUndefined();
        expect(many.state).toMatchObject({ status: "done", moreReceipts: true });
        expect("receipts" in many.state && many.state.receipts).toHaveLength(50);
        expect("result" in many.state && many.state.result).toBeUndefined();
        const rest = await host.call({ ...many.input, receiptsAfter: 50 }, context);
        expect(rest).toMatchObject({
          status: "done",
          moreReceipts: false,
          receipts: [
            { method: "GET", url: "https://example.com/data?page=50" },
            { method: "GET", url: "https://example.com/data?page=51" },
          ],
        });
        expect(rest).toMatchObject({ result: { output: expect.stringContaining("ok") } });
        // Harmless request headers keep a read a read: the approval covers them too.
        const described = await runCode(
          "website-described",
          fetchCode("https://example.com/data?symbols=NVDA", '{headers:{accept:"application/json","user-agent":"Mozilla/5.0"}}'),
        );
        expect(described.pending).toBeUndefined();
        expect(described.state).toMatchObject({
          status: "done",
          receipts: [{ method: "GET", url: "https://example.com/data?symbols=NVDA" }],
        });
        const sentBefore = sent;
        // Any other header, a body, or another origin always asks; nothing is offered to remember for them.
        for (const [callId, headers] of [
          ["website-header", '{"x-mode":"full"}'],
          ["website-authorization", '{accept:"application/json",authorization:"Bearer x"}'],
        ] as const) {
          const header = await runCode(callId, fetchCode("https://example.com/data", `{headers:${headers}}`));
          expect(header.pending).toBeDefined();
          expect(header.pending?.remember).toBeUndefined();
          await decline(header);
        }
        const post = await runCode("website-post", fetchCode("https://example.com/data", '{method:"POST",body:"x"}'));
        expect(post.pending?.remember).toBeUndefined();
        expect(post.pending?.message).toContain("may change data or incur charges");
        await decline(post);
        const other = await runCode("website-other", fetchCode("https://api.example.com/data"));
        expect(other.pending).toMatchObject({ remember: { ...website, approvalScope: "https://api.example.com" } });
        await decline(other);
        // A turn without a signed-in session (`cld`, an API key, a task) never uses it.
        runConfig.mockResolvedValue({ kind: "chat", input: "Run", toolSource: { kind: "none" } });
        const delegated = await runCode("website-delegated", fetchCode("https://example.com/data"));
        expect(delegated.pending).toMatchObject({ remember: website });
        await decline(delegated);
        // Revoked, the next request asks again.
        runConfig.mockResolvedValue({ kind: "chat", input: "Run", toolSource: { kind: "none" }, signedInSession: true });
        await forgetAiToolApproval({ actorUserId: owner.user.id }, { ...website, conversationId });
        const revoked = await runCode("website-revoked", fetchCode("https://example.com/data"));
        expect(revoked.pending).toBeDefined();
        await decline(revoked);
        expect(sent).toBe(sentBefore);
      } finally {
        http.mockRestore();
      }
      await host.sweep(); // Includes the runner host heartbeat.
      const cancelled = {
        ...call,
        callId: "cancelled-run",
        args: {
          code: 'export default async () => { void cloud.http.fetch("https://example.net/cancel-ready").catch(() => {}); await new Promise(() => {}); }',
        },
      };
      // A running call record alone does not prove the runner has compiled and started the code.
      // Its pending approval proves execution started; never approve or send this marker request.
      // Catch its eventual denial separately so the main execution remains pending until the host closes.
      const pending = await wait(cancelled, (state) => state.approvals.some((approval) => approval.decision === null));
      expect(pending).toMatchObject({ status: "running", phase: "waiting_for_user" });
      const active = await aiConversations.getActiveTurn({ conversationId });
      if (!active) throw new Error("Missing test turn");
      turn.mockResolvedValue({ ...active, turn: { ...active.turn, cancelRequestedAt: new Date().toISOString() } });
      await expect(host.call(cancelled, context)).rejects.toThrow("no longer authorized");
      await host.sweep();
      const [cancelledCall] = await sql<{ status: string; result: unknown }[]>`
        SELECT status,result FROM assistant.code_agent_calls WHERE turn_id=${turnId}::uuid AND call_id='cancelled-run'`;
      expect(cancelledCall?.status).toBe("lost");
      expect(cancelledCall?.result).toBeNull();
      turn.mockResolvedValue(active);
      await host.close();
      const executions = start.mock.calls.length;
      // Simulate losing the host after execution but before its result committed.
      await sql`UPDATE assistant.code_agent_calls SET status='running',result=NULL WHERE turn_id=${turnId}::uuid AND call_id=${call.callId}`;
      expect(await wait(call)).toMatchObject({ status: "lost" });
      expect(await wait(call)).toMatchObject({ status: "lost" });
      expect(start).toHaveBeenCalledTimes(executions);
    } finally {
      await host.close();
      transport.mockRestore();
      runner.mockRestore();
      start.mockRestore();
      conversation.mockRestore();
      turn.mockRestore();
      getTurn.mockRestore();
      runConfig.mockRestore();
    }
  }, 120_000);

  test("retired Studio approvals cannot be admitted", async () => {
    await expect(
      approvals.request({
        appId: "demo",
        action: "write",
        subjectId: owner.user.id,
        approverUserId: owner.user.id,
        // @ts-expect-error Old JavaScript callers must fail before accessing persistence too.
        requester: { kind: "studio_app", ref: crypto.randomUUID(), appId: "assistant" },
        assurance: "confirm",
        sentence: "Retired request",
        input: {},
        expiresInMs: 1000,
      }),
    ).rejects.toThrow("Studio approval admission is retired");
  });

  test("personal HTTP secrets stay encrypted, scoped and bound; requests execute only once", async () => {
    const conversationId = crypto.randomUUID(),
      otherId = crypto.randomUUID();
    for (const id of [conversationId, otherId])
      await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${id}::uuid,${owner.user.id}::uuid)`;
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) =>
      request.ownerUserId === owner.user.id ? checkConversation(request.conversationId, owner.user.id) : null,
    );
    const scope = { conversationId };
    try {
      const saved = await httpService.save(
        scope,
        {
          name: "crm",
          origin: "https://api.example.com",
          header: "authorization",
          prefix: "Bearer ",
          value: "fixture-key-not-public",
          expectedRevision: null,
        },
        owner,
      );
      expect(JSON.stringify(saved)).not.toContain("fixture-key");
      expect(JSON.stringify(await httpService.list(scope, owner))).not.toContain("encrypted");
      await expect(httpService.list(scope, stranger)).rejects.toMatchObject({ code: "HTTP_DENIED" });
      const [stored] = await sql<
        { encrypted: string }[]
      >`SELECT encrypted FROM assistant.http_secrets WHERE user_id=${owner.user.id}::uuid AND scope=${"chat:" + conversationId}`;
      expect(stored!.encrypted).not.toContain("fixture-key");
      expect(await secrets.decrypt<string>(stored!.encrypted)).toBe("fixture-key-not-public");
      const make = () =>
        HttpPrepare.parse({
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          scope,
          request: {
            url: "https://api.example.com/v1/items",
            method: "POST",
            headers: { Authorization: { secret: "crm", prefix: "Bearer " } },
            body: btoa("hello"),
          },
        });
      await expect(httpService.prepare(make(), stranger)).rejects.toMatchObject({ code: "HTTP_DENIED" });
      await expect(httpService.list(scope, stranger)).rejects.toMatchObject({ code: "HTTP_DENIED" });
      await expect(httpService.prepare({ ...make(), scope: { conversationId: otherId } }, owner)).rejects.toMatchObject({
        code: "HTTP_SECRET",
      });
      for (const request of [
        { ...make().request, url: "https://other.example.com/v1/items" },
        { ...make().request, headers: { "x-api-key": { secret: "crm", prefix: "Bearer " } } },
        { ...make().request, headers: { authorization: { secret: "crm", prefix: "" } } },
      ])
        await expect(httpService.prepare({ ...make(), request }, owner)).rejects.toMatchObject({ code: "HTTP_SECRET" });
      const call = make();
      expect(JSON.stringify(await httpService.prepare(call, owner))).not.toContain("fixture-key");
      expect(await httpService.prepare(call, owner)).toMatchObject({ id: call.id });
      await expect(
        httpService.prepare({ ...call, request: { ...call.request, url: "https://api.example.com/different" } }, owner),
      ).rejects.toMatchObject({ code: "HTTP_UNKNOWN" });
      let sent = 0;
      const send: Parameters<typeof httpService.execute>[4] = async (request) => {
        sent++;
        expect(request.headers.authorization).toBe("Bearer fixture-key-not-public");
        expect(new TextDecoder().decode(request.body)).toBe("hello");
        return { status: 429, headers: { "retry-after": "2" }, body: new TextEncoder().encode("rate limited") };
      };
      const results = await Promise.allSettled([
        httpService.execute(call.id, true, owner, new AbortController().signal, send),
        httpService.execute(call.id, true, owner, new AbortController().signal, send),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(sent).toBe(1);
      await expect(httpService.execute(call.id, true, owner, new AbortController().signal, send)).rejects.toMatchObject({
        code: "HTTP_UNKNOWN",
      });
      const uncertain = make();
      await httpService.prepare(uncertain, owner);
      await expect(
        httpService.execute(uncertain.id, true, owner, new AbortController().signal, async () => {
          sent++;
          throw new Error("fixture-key-not-public");
        }),
      ).rejects.toMatchObject({ message: "HTTP_UNKNOWN" });
      await expect(httpService.execute(uncertain.id, true, owner, new AbortController().signal, send)).rejects.toMatchObject({
        code: "HTTP_UNKNOWN",
      });
      expect(sent).toBe(2);
      const denied = make();
      await httpService.prepare(denied, owner);
      await expect(httpService.execute(denied.id, false, owner, new AbortController().signal, send)).rejects.toMatchObject({
        code: "HTTP_DENIED",
      });
      expect(sent).toBe(2);
      const changed = make();
      await httpService.prepare(changed, owner);
      const replacement = await httpService.save(scope, { ...saved, value: "replacement", expectedRevision: saved.revision }, owner);
      await expect(httpService.execute(changed.id, true, owner, new AbortController().signal, send)).rejects.toMatchObject({
        code: "HTTP_CONFLICT",
      });
      await expect(httpService.remove(scope, "crm", saved.revision, owner)).rejects.toMatchObject({ code: "HTTP_CONFLICT" });
      await httpService.remove(scope, "crm", replacement.revision, owner);
      await expect(httpService.prepare(make(), owner)).rejects.toMatchObject({ code: "HTTP_SECRET" });
    } finally {
      conversation.mockRestore();
    }
  });

  test("a saved script approval follows current place declarations and can still be declined", async () => {
    const conversationId = crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversationId}::uuid,${owner.user.id}::uuid)`;
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) =>
      request.ownerUserId === owner.user.id ? checkConversation(request.conversationId, owner.user.id) : null,
    );
    const { capabilities } = createAssistantPlaceFixture();
    const manifest = compileCapabilityManifest(PLACE_FIXTURE_APP_ID, capabilities);
    const app = { appId: PLACE_FIXTURE_APP_ID, appName: "Fixture", appDescription: "Invented", appIcon: "ti ti-message", manifest };
    const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { ...app, manifest: { ...manifest, types: manifest.types.map(({ assistant: _assistant, ...type }) => type) } },
    });
    const review = spyOn(capabilityClient, "reviewCapabilityAction").mockResolvedValue({
      ok: true,
      data: { message: "Write at Marta?", approvalScope: "legacy-place:marta" },
    });
    const invoke = spyOn(capabilityClient, "invokeCapability").mockResolvedValue({ ok: true, data: { data: { written: true } } });
    const wording = spyOn(capabilityClient, "getCapabilityActionWording").mockResolvedValue(null);
    const request = {
      id: crypto.randomUUID(),
      name: `${PLACE_FIXTURE_APP_ID}.note.add`,
      input: { text: "Hi" },
      target: { type: PLACE_FIXTURE_TYPE, id: "marta" },
      conversationId,
    };
    const caller = { cookie: "test-cookie", locale: "en", origin: "assistant" as const };
    try {
      expect(await runtimeCapabilities.prepare(request, owner, caller)).toMatchObject({ status: "approval" });
      // The app now reserves this existing Action for checked place tools.
      catalog.mockResolvedValue({ ok: true, data: app });
      await expect(runtimeCapabilities.resolve(request.id, { approved: true }, owner, caller)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
      expect(review).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      const [pending] = await sql`SELECT status FROM assistant.code_capability_calls WHERE id=${request.id}::uuid`;
      expect(pending).toMatchObject({ status: "pending" });
      catalog.mockResolvedValue({ ok: false, error: { code: "APP_UNAVAILABLE", message: "Unavailable", status: 503 } });
      expect(await runtimeCapabilities.resolve(request.id, { approved: false }, owner, caller)).toEqual({ status: "denied" });
      expect(catalog).toHaveBeenCalledTimes(2);
      const [denied] = await sql`SELECT call.status,approval.status AS approval_status
        FROM assistant.code_capability_calls call JOIN approvals.requests approval ON approval.id=call.approval_id
        WHERE call.id=${request.id}::uuid`;
      expect(denied).toMatchObject({ status: "denied", approval_status: "rejected" });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      conversation.mockRestore();
      catalog.mockRestore();
      review.mockRestore();
      invoke.mockRestore();
      wording.mockRestore();
      await sql`DELETE FROM assistant.code_capability_calls WHERE id=${request.id}::uuid`;
      await sql`DELETE FROM ai.conversations WHERE id=${conversationId}::uuid`;
    }
  });

  test("script capabilities require real approval, remember scopes and never execute twice", async () => {
    const conversationId = crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversationId}::uuid,${owner.user.id}::uuid)`;
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) =>
      request.ownerUserId === owner.user.id ? checkConversation(request.conversationId, owner.user.id) : null,
    );
    const definitions = defineCapabilities({
      protocolVersion: 2,
      actions: {
        write: {
          title: "Write item",
          description: "Write a test item",
          input: z.object({ value: z.string().describe("Value") }).strict(),
          data: z.unknown(),
          approval: "rememberable",
          idempotency: "required",
          destructive: false,
          openWorld: false,
          review: async () => ok({ message: "Write item?", approvalScope: "items:one" }),
          run: async () => ok({ data: {} }),
        },
      },
    });
    const manifest = compileCapabilityManifest("demo", definitions);
    const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "demo", appName: "Demo", appDescription: "", appIcon: "ti ti-app-window", manifest },
    });
    const review = spyOn(capabilityClient, "reviewCapabilityAction").mockResolvedValue({
      ok: true,
      data: { message: "Write item?", approvalScope: "items:one" },
    });
    const execute = spyOn(capabilityClient, "invokeCapability").mockResolvedValue({ ok: true, data: { data: { written: true } } });
    const wording = spyOn(capabilityClient, "getCapabilityActionWording").mockResolvedValue({
      title: "Write",
      sentences: { approval: "Write {input.value}" },
      fields: [{ path: "input.value", label: "Value" }],
    });
    const caller = { cookie: "test-cookie", locale: "en" };
    const request = () => ({ id: crypto.randomUUID(), name: "demo.write", input: { value: "one" }, conversationId });
    const approvalFor = async (id: string) => {
      const [call] = await sql<
        { approval_id: string | null }[]
      >`SELECT approval_id FROM assistant.code_capability_calls WHERE id=${id}::uuid`;
      if (!call?.approval_id) throw new Error("Missing platform approval");
      return (await approvals.get(call.approval_id))!;
    };
    try {
      const typedReview = {
        locale: "en",
        sentence: { action: "Write item", running: "Writing item", done: "Wrote item", confirm: "Write item", decline: "Do not write" },
        slots: {},
        content: { kind: "page" as const, title: "Draft", body: `${"x".repeat(65_536)}\u0000\ud800END\udc00`, format: "plain" as const },
      };
      catalog.mockResolvedValueOnce({
        ok: true,
        data: {
          appId: "demo",
          appName: "Demo",
          appDescription: "",
          appIcon: "ti ti-app-window",
          manifest: { ...manifest, policies: { write: { ask: "cannot_undo" } } },
        },
      });
      review.mockResolvedValueOnce({ ok: true, data: typedReview });
      const typed = request();
      expect(await runtimeCapabilities.prepare(typed, owner, caller)).toMatchObject({
        status: "approval",
        review: { ...typedReview, ask: "cannot_undo" },
      });
      expect((await approvalFor(typed.id)).details).toEqual(typedReview);
      expect((await approvalFor(typed.id)).reviewDigest).toBe(approvalReviewDigest(typedReview));
      const [saved] = await sql<
        { prepared: { review: string } }[]
      >`SELECT prepared FROM assistant.code_capability_calls WHERE id=${typed.id}::uuid`;
      expect(JSON.parse(saved!.prepared.review)).toEqual(typedReview);
      await runtimeCapabilities.resolve(typed.id, { approved: false }, owner, caller);
      // Positive resolution must decode the persisted review before comparing its digest.
      const acceptedContent = request();
      review.mockResolvedValueOnce({ ok: true, data: typedReview });
      await runtimeCapabilities.prepare(acceptedContent, owner, caller);
      review.mockResolvedValueOnce({ ok: true, data: typedReview });
      expect(await runtimeCapabilities.resolve(acceptedContent.id, { approved: true }, owner, caller)).toMatchObject({
        status: "completed",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockClear();
      const denied = request();
      // The card gets the Action's wording in the caller's locale, as a chat call of the same Action would.
      expect(await runtimeCapabilities.prepare(denied, owner, caller)).toMatchObject({
        status: "approval",
        allowAlways: true,
        sentences: { approval: "Write {input.value}" },
        fields: [{ path: "input.value", label: "Value" }],
      });
      expect(wording).toHaveBeenCalledWith("demo", "write", "en", null);
      expect(execute).not.toHaveBeenCalled();
      await expect(runtimeCapabilities.resolve(denied.id, { approved: true }, stranger, caller)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(runtimeCapabilities.resolve(denied.id, { approved: false }, stranger, caller)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const readsBeforeDecline = catalog.mock.calls.length;
      expect(await runtimeCapabilities.resolve(denied.id, { approved: false }, owner, caller)).toEqual({ status: "denied" });
      expect(catalog.mock.calls.length).toBe(readsBeforeDecline);
      expect(await approvalFor(denied.id)).toMatchObject({
        status: "rejected",
        decidedVia: "web_session",
        requesterTitle: null,
        assurance: "standard",
      });
      expect(execute).not.toHaveBeenCalled();
      const expired = request();
      await runtimeCapabilities.prepare(expired, owner, caller);
      const expiredApproval = await approvalFor(expired.id);
      await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expiredApproval.id}::uuid`;
      await expect(runtimeCapabilities.resolve(expired.id, { approved: true }, owner, caller)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await approvalFor(expired.id)).toMatchObject({ status: "expired" });
      expect(await runtimeCapabilities.resolve(expired.id, { approved: false }, owner, caller)).toEqual({ status: "denied" });
      expect(execute).not.toHaveBeenCalled();
      const changed = request();
      await runtimeCapabilities.prepare(changed, owner, caller);
      review.mockResolvedValueOnce({ ok: true, data: { message: "A different consequence", approvalScope: "items:other" } });
      await expect(runtimeCapabilities.resolve(changed.id, { approved: true }, owner, caller)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(execute).not.toHaveBeenCalled();
      await runtimeCapabilities.resolve(changed.id, { approved: false }, owner, caller);
      // Approving after a language switch is the same consequence: the review is repeated in the reviewed locale.
      const switched = request();
      await runtimeCapabilities.prepare(switched, owner, { ...caller, locale: "de" });
      review.mockImplementationOnce(async (_invocation, reviewer) =>
        reviewer.locale === "de"
          ? { ok: true, data: { message: "Write item?", approvalScope: "items:one" } }
          : { ok: true, data: { message: "Translated consequence", approvalScope: "items:one" } },
      );
      expect(await runtimeCapabilities.resolve(switched.id, { approved: true }, owner, caller)).toMatchObject({ status: "completed" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await approvalFor(switched.id)).toMatchObject({ status: "consumed", decidedVia: "web_session" });
      execute.mockClear();
      const relay = request();
      await runtimeCapabilities.prepare(relay, owner, caller);
      const relayedIdentity = { ...owner, credentialKind: "invocation" as const };
      await expect(runtimeCapabilities.resolve(relay.id, { approved: true }, relayedIdentity, caller)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(await approvalFor(relay.id)).toMatchObject({ status: "pending" });
      expect(execute).not.toHaveBeenCalled();
      const linked = await approvalFor(relay.id);
      await approvals.decide(linked.id, { approved: true }, { userId: owner.user.id, via: "web_session" });
      expect(await runtimeCapabilities.resolve(relay.id, { approved: true }, relayedIdentity, caller)).toMatchObject({
        status: "completed",
      });
      expect(await approvalFor(relay.id)).toMatchObject({ id: linked.id, status: "consumed", decidedVia: "web_session" });
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockClear();
      // Simulate a call saved before the platform migration; no catalog is needed to decline it.
      const legacy = request();
      await runtimeCapabilities.prepare(legacy, owner, caller);
      const legacyApproval = await approvalFor(legacy.id);
      await sql`UPDATE assistant.code_capability_calls SET approval_id=NULL WHERE id=${legacy.id}::uuid`;
      await sql`DELETE FROM approvals.requests WHERE id=${legacyApproval.id}::uuid`;
      const readsBeforeLegacyDecline = catalog.mock.calls.length;
      expect(await runtimeCapabilities.resolve(legacy.id, { approved: false }, relayedIdentity, caller)).toEqual({ status: "denied" });
      expect(catalog.mock.calls.length).toBe(readsBeforeLegacyDecline);
      expect(await approvalFor(legacy.id)).toMatchObject({
        status: "rejected",
        decidedVia: "invocation",
        requesterKind: "assistant_turn",
        requesterRef: `${conversationId}/code/${legacy.id}`,
      });
      const legacyApproved = request();
      await runtimeCapabilities.prepare(legacyApproved, owner, caller);
      const previous = await approvalFor(legacyApproved.id);
      await sql`UPDATE assistant.code_capability_calls SET approval_id=NULL WHERE id=${legacyApproved.id}::uuid`;
      await sql`DELETE FROM approvals.requests WHERE id=${previous.id}::uuid`;
      await runtimeCapabilities.resolve(legacyApproved.id, { approved: true }, owner, caller);
      expect(await approvalFor(legacyApproved.id)).toMatchObject({ status: "consumed", decidedVia: "web_session" });
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockClear();
      // A call from before the upgrade keeps the day it had to wait: an older one can only be declined.
      const overdue = request();
      await runtimeCapabilities.prepare(overdue, owner, caller);
      await sql`DELETE FROM approvals.requests WHERE id=${(await approvalFor(overdue.id)).id}::uuid`;
      await sql`UPDATE assistant.code_capability_calls SET approval_id=NULL,created_at=now()-interval '2 days' WHERE id=${overdue.id}::uuid`;
      await expect(runtimeCapabilities.resolve(overdue.id, { approved: true }, owner, caller)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(await approvalFor(overdue.id)).toMatchObject({ status: "expired" });
      expect(await runtimeCapabilities.resolve(overdue.id, { approved: false }, owner, caller)).toEqual({ status: "denied" });
      // A call that waited past a day is abandoned with its open approval when the next call is prepared.
      const stale = request();
      await runtimeCapabilities.prepare(stale, owner, caller);
      await sql`UPDATE assistant.code_capability_calls SET created_at=now()-interval '2 days' WHERE id=${stale.id}::uuid`;
      // A rememberable Action whose review leaves out the scope asks as `confirm`, as in a chat.
      review.mockResolvedValueOnce({ ok: true, data: { message: "Write item into another base?" } });
      const scopeless = request();
      await runtimeCapabilities.prepare(scopeless, owner, caller);
      expect(await approvalFor(stale.id)).toMatchObject({ status: "cancelled" });
      expect(await approvalFor(scopeless.id)).toMatchObject({ assurance: "confirm" });
      expect(await runtimeCapabilities.resolve(scopeless.id, { approved: false }, owner, caller)).toEqual({ status: "denied" });
      // A call ID an earlier approval request still holds never inherits that request or its decision.
      await sql`DELETE FROM assistant.code_capability_calls WHERE id=${scopeless.id}::uuid`;
      await expect(runtimeCapabilities.prepare(scopeless, owner, caller)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(execute).not.toHaveBeenCalled();
      const approved = request();
      await runtimeCapabilities.prepare(approved, owner, caller);
      await runtimeCapabilities.resolve(approved.id, { approved: true, remember: "always" }, owner, caller);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await approvalFor(approved.id)).toMatchObject({ status: "consumed", decidedVia: "web_session" });
      expect(execute.mock.calls[0]![0]).toMatchObject({ idempotencyKey: `code-${approved.id}`, input: { value: "one" } });
      // The remembered approval's audit event joins the execution trail through the call ID.
      expect(
        await sql`SELECT action, request_id FROM audit.events WHERE action = 'ai.approval.remember' AND request_id = ${approved.id}`,
      ).toHaveLength(1);
      expect(await runtimeCapabilities.resolve(approved.id, { approved: true }, owner, caller)).toEqual({
        status: "completed",
        result: { ok: true, data: { data: { written: true } } },
      });
      const [stored] = await sql<
        { request: string; prepared: string; result: string }[]
      >`SELECT jsonb_typeof(request) AS request,jsonb_typeof(prepared) AS prepared,jsonb_typeof(result) AS result
        FROM assistant.code_capability_calls WHERE id=${approved.id}::uuid`;
      expect(stored).toEqual({ request: "object", prepared: "object", result: "object" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await runtimeCapabilities.prepare(request(), owner, caller)).toMatchObject({ status: "completed" });
      expect(execute).toHaveBeenCalledTimes(2);
      await expect(runtimeCapabilities.prepare(request(), stranger, caller)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally {
      conversation.mockRestore();
      catalog.mockRestore();
      review.mockRestore();
      execute.mockRestore();
      wording.mockRestore();
    }
  });

  test("code capabilities honor an approval remembered for their chat, and only there", async () => {
    const definitions = defineCapabilities({
      protocolVersion: 2,
      actions: {
        write: {
          title: "Write item",
          description: "Write a test item",
          input: z.object({ value: z.string().describe("Value") }).strict(),
          data: z.unknown(),
          approval: "rememberable",
          idempotency: "required",
          destructive: false,
          openWorld: false,
          review: async () => ok({ message: "Write item?", approvalScope: "items:one" }),
          run: async () => ok({ data: {} }),
        },
      },
    });
    const manifest = compileCapabilityManifest("chatdemo", definitions);
    const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "chatdemo", appName: "Demo", appDescription: "", appIcon: "ti ti-app-window", manifest },
    });
    const review = spyOn(capabilityClient, "reviewCapabilityAction").mockResolvedValue({
      ok: true,
      data: { message: "Write item?", approvalScope: "items:one" },
    });
    const execute = spyOn(capabilityClient, "invokeCapability").mockResolvedValue({ ok: true, data: { data: { written: true } } });
    // The card for the other chat words the call from the live registry, which this test does not run.
    const wording = spyOn(capabilityClient, "getCapabilityActionWording").mockResolvedValue(null);
    const [remembered, other] = [crypto.randomUUID(), crypto.randomUUID()];
    for (const chat of [remembered, other])
      await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${chat}::uuid,${owner.user.id}::uuid)`;
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) =>
      checkConversation(request.conversationId, owner.user.id),
    );
    const request = (conversationId: string) => ({
      id: crypto.randomUUID(),
      name: "chatdemo.write",
      input: { value: "one" },
      conversationId,
    });
    try {
      await rememberAiToolApproval(
        { actorUserId: owner.user.id },
        { toolName: "chatdemo.write", approvalScope: "items:one", conversationId: remembered },
      );
      expect(await runtimeCapabilities.prepare(request(remembered), owner, {})).toMatchObject({ status: "completed" });
      expect(await runtimeCapabilities.prepare(request(other), owner, {})).toMatchObject({ status: "approval", allowAlways: true });
      // A chat approval ends with its chat.
      await sql`DELETE FROM ai.conversations WHERE id=${remembered}::uuid`;
      expect((await sql`SELECT id FROM ai.tool_approval_preferences WHERE tool_name='chatdemo.write'`).length).toBe(0);
    } finally {
      catalog.mockRestore();
      review.mockRestore();
      execute.mockRestore();
      wording.mockRestore();
      conversation.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id IN (${remembered}::uuid,${other}::uuid)`;
    }
  });

  test("binary streams require this user's completed consent and fresh resource access", async () => {
    const conversationId = crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversationId}::uuid,${owner.user.id}::uuid)`;
    let accessible = true;
    const conversation = spyOn(aiConversations, "getConversation").mockImplementation(async (request) =>
      accessible && request.ownerUserId === owner.user.id ? checkConversation(conversationId, owner.user.id) : null,
    );
    const descriptor = {
      id: "sealed-reference",
      direction: "read" as const,
      mediaType: "application/pdf",
      size: 3,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const manifest = compileCapabilityManifest(
      "binary",
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          read: {
            title: "Read bytes",
            description: "Read a PDF",
            input: z.object({}).strict(),
            data: z.object({}),
            openWorld: false,
            stream: { direction: "read", maxBytes: 10, read: async () => new Response("pdf") },
            run: () => ok({ data: {}, stream: descriptor }),
          },
        },
      }),
    );
    const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "binary", appName: "Binary", appDescription: "", appIcon: "ti ti-file", manifest },
    });
    const execute = spyOn(capabilityClient, "invokeCapability").mockResolvedValue({ ok: true, data: { data: {}, stream: descriptor } });
    const transfer = spyOn(capabilityClient, "transferCapabilityStream").mockImplementation(async () => new Response("pdf"));
    const input = { id: crypto.randomUUID(), name: "binary.read", input: {}, conversationId };
    try {
      await expect(runtimeCapabilities.stream(input.id, "read", null, owner, {})).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(await runtimeCapabilities.prepare(input, owner, {})).toMatchObject({ status: "completed" });
      expect(transfer).not.toHaveBeenCalled();
      expect(await (await runtimeCapabilities.stream(input.id, "read", null, owner, {})).text()).toBe("pdf");
      expect(transfer.mock.calls[0]?.[0]).toEqual(descriptor);
      await expect(runtimeCapabilities.stream(input.id, "read", null, stranger, {})).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      accessible = false;
      await expect(runtimeCapabilities.stream(input.id, "read", null, owner, {})).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(transfer).toHaveBeenCalledTimes(1);
    } finally {
      conversation.mockRestore();
      catalog.mockRestore();
      execute.mockRestore();
      transfer.mockRestore();
    }
  });

  test("every capability runtime route rechecks chat Project access before catalog, execution, results, or streams", async () => {
    const projectId = "00000000-0000-4000-8000-000000000091";
    const conversationId = "00000000-0000-4000-8000-000000000092";
    await sql`INSERT INTO ai.projects(id,short_id,name) VALUES(${projectId}::uuid,'Prj234','Runtime access')`;
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
      VALUES(${owner.user.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO ai.project_access VALUES(${projectId}::uuid,${grant!.id}::uuid)`;
    const chat = {
      ...checkConversation(conversationId, owner.user.id),
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      lastUsedAt: "2026-10-22T00:00:00.000Z",
      projectId,
      allowedTools: ["access.read", "access.write"],
    };
    // This suite has a minimal conversation table; Project grants and capability-call storage are real.
    const conversation = spyOn(aiConversations, "getConversation").mockResolvedValue(chat);
    const short = spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(chat);
    const sharedAccess = spyOn(chatAccess, "requireToolChat");
    const manifest = compileCapabilityManifest(
      "access",
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          read: {
            title: "Read",
            description: "Read test data",
            openWorld: false,
            input: z.object({}).strict(),
            data: z.unknown(),
            run: async () => ok({ data: {} }),
          },
        },
        actions: {
          write: {
            title: "Write",
            description: "Write test data",
            openWorld: false,
            destructive: false,
            input: z.object({}).strict(),
            data: z.unknown(),
            idempotency: "required",
            run: async () => ok({ data: {} }),
          },
        },
      }),
    );
    const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "access", appName: "Access", appDescription: "", appIcon: "", manifest },
    });
    const stream = {
      id: "test-stream",
      direction: "read" as const,
      mediaType: "text/plain",
      size: 3,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const execute = spyOn(capabilityClient, "invokeCapability").mockResolvedValue({ ok: true, data: { data: {}, stream } });
    const wording = spyOn(capabilityClient, "getCapabilityActionWording").mockResolvedValue(null);
    const transfer = spyOn(capabilityClient, "transferCapabilityStream").mockImplementation(async () => new Response("abc"));
    const routes = createChatCodeServiceRoutes();
    const api = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("credentialKind", "session");
        c.set("actor", owner.actor);
        c.set("accessSubject", owner.accessSubject);
        await next();
      })
      .route("/", routes);
    const post = (path: string, body: unknown) =>
      api.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const readId = "00000000-0000-4000-8000-000000000093";
    const pendingId = "00000000-0000-4000-8000-000000000094";
    const rejectId = "00000000-0000-4000-8000-000000000095";
    const request = (id: string, name: string, reference = conversationId) => ({ id, name, input: {}, conversationId: reference });
    try {
      expect((await aiProjects.get(projectId, owner, "read"))?.permission).toBe("read");
      expect((await post("/runtime/capabilities", request(readId, "access.read"))).status).toBe(200);
      for (const id of [pendingId, rejectId]) {
        expect(await (await post("/runtime/capabilities", request(id, "access.write"))).json()).toMatchObject({
          status: "approval",
        });
      }
      for (const reference of [conversationId, chat.shortId]) {
        await sql`UPDATE assistant.code_capability_calls SET request=jsonb_set(request, '{conversationId}', ${JSON.stringify(reference)}::text::jsonb)
          WHERE id IN (${readId}::uuid,${pendingId}::uuid)`;
        const cases = [
          {
            route: "/runtime/capabilities",
            path: "/runtime/capabilities",
            body: request(crypto.randomUUID(), "access.read", reference),
            tool: "access.read",
          },
          {
            route: "/runtime/capabilities/:id/resolve",
            path: `/runtime/capabilities/${readId}/resolve`,
            body: { approved: true },
            tool: "access.read",
          },
          ...["read", "write", "status", "abort"].map((verb) => ({
            route: "/runtime/capabilities/:id/stream/:verb",
            path: `/runtime/capabilities/${readId}/stream/${verb}`,
            body: {},
            tool: "access.read",
          })),
        ];
        // Discover the real route table: a new capability route must join this behavioral access matrix.
        expect(
          [
            ...new Set(
              routes.routes.filter((route) => /\/runtime\/.*capabilit/.test(route.path)).map((route) => `${route.method} ${route.path}`),
            ),
          ].sort(),
        ).toEqual([...new Set(cases.map((entry) => `POST ${entry.route}`))].sort());
        for (const entry of cases) {
          sharedAccess.mockClear();
          expect((await post(entry.path, entry.body)).status, entry.path).toBe(200);
          expect(sharedAccess).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ accessSubject: owner.accessSubject }),
            entry.tool,
          );
        }
        // Revoke the real Project grant while keeping ownership, tool scope and call records intact.
        await sql`DELETE FROM ai.project_access WHERE project_id=${projectId}::uuid`;
        expect(await aiProjects.get(projectId, owner, "read")).toBeNull();
        catalog.mockClear();
        execute.mockClear();
        transfer.mockClear();
        for (const entry of [
          ...cases,
          {
            path: `/runtime/capabilities/${pendingId}/resolve`,
            body: { approved: true },
            tool: "access.write",
          },
        ]) {
          sharedAccess.mockClear();
          expect((await post(entry.path, entry.body)).status, entry.path).toBe(403);
          expect(sharedAccess).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ accessSubject: owner.accessSubject }),
            entry.tool,
          );
        }
        // Direct runner callers use this same service entry, with no HTTP middleware to rely on.
        await expect(runtimeCapabilities.prepare(request(crypto.randomUUID(), "access.write", reference), owner, {})).rejects.toMatchObject(
          { code: "ACCESS_DENIED" },
        );
        expect(catalog).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
        await sql`INSERT INTO ai.project_access VALUES(${projectId}::uuid,${grant!.id}::uuid)`;
        // Revoking the target tool also denies every continuation, even with Project read restored.
        conversation.mockResolvedValue({ ...chat, allowedTools: ["code_run"] });
        short.mockResolvedValue({ ...chat, allowedTools: ["code_run"] });
        for (const entry of cases) expect((await post(entry.path, entry.body)).status, entry.path).toBe(403);
        expect(catalog).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
        conversation.mockResolvedValue(chat);
        short.mockResolvedValue(chat);
      }
      conversation.mockResolvedValue(chat);
      expect(await (await post(`/runtime/capabilities/${pendingId}/resolve`, { approved: true })).json()).toMatchObject({
        status: "completed",
      });
      await sql`DELETE FROM ai.project_access WHERE project_id=${projectId}::uuid`;
      expect(await (await post(`/runtime/capabilities/${rejectId}/resolve`, { approved: false })).json()).toMatchObject({
        status: "denied",
      });
    } finally {
      for (const spy of [conversation, short, sharedAccess, catalog, execute, wording, transfer]) spy.mockRestore();
      await sql`DELETE FROM assistant.code_capability_calls WHERE conversation_id=${conversationId}`;
      await sql`DELETE FROM ai.project_access WHERE project_id=${projectId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      await sql`DELETE FROM ai.projects WHERE id=${projectId}::uuid`;
    }
  });
});
