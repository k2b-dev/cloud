import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql, startProcessSync } from "@k2b/cloud";
import * as execution from "@k2b/cloud/ai";
import { encodeChatValue } from "@k2b/cloud/code/chat-run";
import * as notifications from "@k2b/cloud/code/chat-run-wake";
import { CHAT_RUN_FALLBACK_MS, notifyChatRun, openChatRunWake } from "@k2b/cloud/code/chat-run-wake";
import { RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import type { AuthContext } from "@k2b/cloud/server";
import { SQL } from "bun";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { createRunnerCodeHost } from "../../../assistant/src/chat-code/runner-code-host";
import { testIdentity } from "../../../assistant/src/chat-code/test-identity";
import { migrate } from "../migrate/core/code-jobs";
import { callChatJob, createChatRunnerRoutes } from "./chat-runner";
import { claimCodeJob, completeCodeJob, fenceCodeJob, heartbeatCodeJob, reconcileCodeJobs } from "./runner-jobs";
import { codeSettings } from "./settings";

suiteFor("database", "nats")("chat runner mailbox fencing", () => {
  let runtime: Awaited<ReturnType<typeof startProcessSync>>;
  let authorization: ReturnType<typeof spyOn<typeof execution, "authorizeCodeExecution">>;
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const owner = "11111111-1111-4111-8111-111111111111";
  const conversation = "22222222-2222-4222-8222-222222222222";
  const turn = "33333333-3333-4333-8333-333333333333";
  beforeAll(async () => {
    database = await useFreshDatabase("chat_runner_mailbox");
    await sql`CREATE SCHEMA code`;
    await migrate();
    runtime = await startProcessSync({ application: "core" });
    // Reconciliation updates this registry only when heartbeating; no runner process is started.
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.jobs`;
    setSystemTime(Date.UTC(2026, 0, 2));
    // The turn-admission seam is tested separately; the mailbox never consumes its return value.
    authorization = spyOn(execution, "authorizeCodeExecution").mockResolvedValue(
      {} as Awaited<ReturnType<typeof execution.authorizeCodeExecution>>,
    );
  });
  afterEach(() => {
    authorization.mockRestore();
    setSystemTime();
  });
  afterAll(async () => {
    await runtime.stop();
    await database.drop();
  });
  async function fixture() {
    const [job] = await sql<
      { id: string }[]
    >`INSERT INTO code.jobs(kind,owner_id,conversation_id,turn_id,input,input_bytes,output_bytes,deadline_at,calls_limit,call_bytes)
      VALUES('chat',${owner}::uuid,${conversation}::uuid,${turn}::uuid,'{}',2,1000,clock_timestamp()+interval '1 minute',200,262144) RETURNING id`;
    const lease = await sql.begin((db) => claimCodeJob(crypto.randomUUID(), db));
    if (!lease || !job) throw new Error("Missing job");
    const callId = crypto.randomUUID();
    await sql`INSERT INTO code.job_calls(id,job_id,generation,operation,input) VALUES(${callId}::uuid,${job.id}::uuid,${lease.generation},'chat.message','[]')`;
    const app = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("actor", {
          kind: "user",
          user: {
            id: owner,
            uid: owner,
            provider: "local",
            profile: "user",
            displayName: "Fixture",
            givenname: "Test",
            sn: "Runner",
            roles: [],
            mail: null,
            avatarHash: null,
            ipa: null,
            accountExpires: null,
            lastLoginLocal: null,
            memberofGroup: [],
            memberofGroupIds: [],
            manages: [],
            managesGroupIds: [],
          },
        });
        await next();
      })
      .route("/:conversationId/:turnId", createChatRunnerRoutes());
    const request = (operation: string, body: unknown = {}, chat = conversation) =>
      app.request(`/${chat}/${turn}/${job.id}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { job, lease, callId, request };
  }
  test("poll claims effects once, binds the chat, and resolves only its current generation", async () => {
    const f = await fixture();
    expect((await f.request("poll", {}, owner)).status).toBe(404);
    expect(await (await f.request("poll")).json()).toMatchObject({
      state: "running",
      calls: [{ id: f.callId, operation: "chat.message" }],
    });
    expect(await (await f.request("poll")).json()).toMatchObject({ calls: [] });
    expect((await f.request("resolve", { id: f.callId, result: { ok: true, value: ["json", "42\u0000"] } })).status).toBe(200);
    const [call] = await sql`SELECT state,result,input FROM code.job_calls WHERE id=${f.callId}::uuid`;
    expect(call).toMatchObject({ state: "done", result: JSON.stringify({ ok: true, value: ["json", "42\u0000"] }), input: null });
    expect(await (await f.request("status", { id: f.callId })).json()).toEqual({ active: false });
    await f.request("cancel");
    await expect(sql.begin((db) => fenceCodeJob(f.lease, db))).rejects.toBeInstanceOf(RunnerLeaseLostError);
  });
  test("expired chat work is terminal, never delivered or automatically replayed", async () => {
    const f = await fixture();
    await sql`UPDATE code.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.job.id}::uuid`;
    expect(await (await f.request("poll")).json()).toMatchObject({ state: "failed", calls: [], result: { code: "code_job_time_limit" } });
    const settings = spyOn(codeSettings, "get").mockResolvedValue(3);
    try {
      await reconcileCodeJobs();
    } finally {
      settings.mockRestore();
    }
    expect(await sql.begin((db) => claimCodeJob(crypto.randomUUID(), db))).toBeUndefined();
    await expect(sql.begin((db) => fenceCodeJob(f.lease, db))).rejects.toBeInstanceOf(RunnerLeaseLostError);
  });
  test("heartbeat stops a chat job when its originating turn is cancelled or finished", async () => {
    const f = await fixture();
    const authorization = spyOn(execution, "authorizeCodeExecution").mockRejectedValue(new Error("Turn ended"));
    try {
      await expect(heartbeatCodeJob(f.lease)).rejects.toBeInstanceOf(RunnerLeaseLostError);
    } finally {
      authorization.mockRestore();
    }
    const [job] = await sql`SELECT state,lease_key_hash FROM code.jobs WHERE id=${f.job.id}::uuid`;
    expect(job).toMatchObject({ state: "cancelled", lease_key_hash: null });
  });
  async function waitingCall(f: Awaited<ReturnType<typeof fixture>>, signal: AbortSignal) {
    const mailbox = await openChatRunWake(f.job.id, "mailbox", signal);
    const id = crypto.randomUUID();
    const result = callChatJob({ ...f.lease, id, operation: "chat.message", input: [] }, signal);
    // Observe the committed admission without adding a database read to the measured path.
    await mailbox.wait();
    mailbox.close();
    return { id, result };
  }
  test("SQL budget: zero SQL per idle tick, one read per reply event and one read per 2-second fallback", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const call = await waitingCall(f, controller.signal);
    const writer = new SQL(database.url);
    const meter = await meterSql();
    try {
      // No notification, no fallback deadline: ordinary former 100 ms ticks are SQL-free.
      expect(await meter.during(() => Bun.sleep(350))).toEqual([]);
      const fallback = await meter.during(() => Bun.sleep(CHAT_RUN_FALLBACK_MS));
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toStartWith("SELECT c.result");
      const reply = { ok: true as const, value: ["json", "reply"] };
      // A different Core connection commits first, then publishes only an invalidation hint.
      await writer`UPDATE code.job_calls SET state='done',result=${JSON.stringify(reply)},input=NULL WHERE id=${call.id}::uuid`;
      const event = await meter.during(async () => {
        notifyChatRun(f.job.id, call.id);
        expect(await call.result).toEqual(reply);
      });
      expect(event).toHaveLength(1);
      expect(event[0]).toStartWith("SELECT c.result");
    } finally {
      controller.abort();
      await call.result.catch(() => {});
      await meter.close();
      await writer.close();
    }
  });
  test("a lost reply notification recovers from durable state on the slow fallback", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const call = await waitingCall(f, controller.signal);
    const writer = new SQL(database.url);
    const meter = await meterSql();
    try {
      const reply = { ok: true as const, value: ["json", "lost hint"] };
      await writer`UPDATE code.job_calls SET state='done',result=${JSON.stringify(reply)},input=NULL WHERE id=${call.id}::uuid`;
      const fallback = await meter.during(async () => expect(await call.result).toEqual(reply));
      expect(fallback).toHaveLength(1);
    } finally {
      controller.abort();
      await call.result.catch(() => {});
      await meter.close();
      await writer.close();
    }
  });
  test.each(["cancel", "expiry", "restart", "disconnect"])("a waiting call stays fenced after %s", async (kind) => {
    const f = await fixture();
    const controller = new AbortController();
    const call = await waitingCall(f, controller.signal);
    const rejected = call.result.catch((error: unknown) => error);
    const hints = spyOn(notifications, "notifyChatRun");
    try {
      if (kind === "cancel") await f.request("cancel");
      if (kind === "expiry" || kind === "restart") {
        await sql`UPDATE code.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.job.id}::uuid`;
        if (kind === "restart") {
          const settings = spyOn(codeSettings, "get").mockResolvedValue(3);
          try {
            await reconcileCodeJobs();
          } finally {
            settings.mockRestore();
          }
          expect(await sql.begin((db) => claimCodeJob(crypto.randomUUID(), db))).toBeUndefined();
        }
      }
      if (kind === "disconnect") {
        await f.request("poll"); // Delivery is already claimed; disconnect must never replay it.
        controller.abort();
      }
      if (kind === "cancel" || kind === "restart") expect(hints).toHaveBeenCalledWith(f.job.id, "status");
      expect(await rejected).toBeInstanceOf(RunnerLeaseLostError);
      expect(await (await f.request("poll")).json()).toMatchObject({ calls: [] });
    } finally {
      hints.mockRestore();
      controller.abort();
      await call.result.catch(() => {});
    }
  });
  async function remoteFixture() {
    const f = await fixture();
    await sql`UPDATE code.job_calls SET input=${JSON.stringify(await encodeChatValue({ type: "ready" }))} WHERE id=${f.callId}::uuid`;
    let polls = 0;
    const terminal = Promise.withResolvers<void>();
    const bootResolved = Promise.withResolvers<void>();
    const resolutions = new Map<string, () => void>();
    const pollWaiters = new Set<() => void>();
    const host = createRunnerCodeHost({
      current: () => ({
        turnId: turn,
        context: {
          ...testIdentity(owner),
          conversationId: conversation,
          locale: "en",
          timeZone: "UTC",
          signal: new AbortController().signal,
        },
      }),
      approve: async () => ({ approved: true }),
      fetch: async () => {
        throw new Error("No app request expected");
      },
      transport: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/start")) return Response.json({ id: f.job.id, deadlineAt: Date.now() + 60_000 });
        const operation = path.split("/").at(-1)!;
        if (operation === "poll") polls++;
        const body = await request.json();
        const response = await f.request(operation, body);
        if (operation === "resolve") {
          bootResolved.resolve();
          resolutions.get(body.id)?.();
        }
        if (operation === "poll") {
          if ((await response.clone().json()).state === "succeeded") terminal.resolve();
          for (const resolve of pollWaiters) resolve();
          pollWaiters.clear();
        }
        return response;
      },
    });
    const tool = (name: "code_run" | "code_inspect", args: unknown) =>
      host.execute({ name, args, callId: "remote-run", conversationId: conversation, turnId: turn });
    expect(await tool("code_run", { code: "export default () => 42;" })).toMatchObject({ status: "ready" });
    await bootResolved.promise;
    return {
      f,
      host,
      tool,
      resolutions,
      terminal,
      polls: () => polls,
      nextPoll: () => new Promise<void>((resolve) => pollWaiters.add(resolve)),
    };
  }
  test("remote mailbox fallback SQL budget: one durable snapshot every 2 seconds", async () => {
    const remote = await remoteFixture();
    const meter = await meterSql();
    const initial = remote.polls();
    try {
      const fallback = await meter.during(() => remote.nextPoll());
      expect(remote.polls()).toBe(initial + 1);
      expect(fallback).toHaveLength(5);
      expect(fallback.filter((statement) => statement.startsWith("SELECT "))).toHaveLength(1);
    } finally {
      await remote.host.close();
      await meter.close();
    }
  });
  test("remote Assistant mailbox: idle budget, committed message/reply wakeups, lost hint and terminal status", async () => {
    const { f, host, tool, resolutions, terminal, polls } = await remoteFixture();
    const meter = await meterSql();
    const writer = new SQL(database.url);
    const controller = new AbortController();
    try {
      const initial = polls();
      expect(await meter.during(() => Bun.sleep(350))).toEqual([]);
      expect(polls()).toBe(initial);
      // One actual message causes one mailbox snapshot (one SELECT, claim + expiry UPDATE, BEGIN/COMMIT).
      const id = crypto.randomUUID();
      const replyWake = await openChatRunWake(f.job.id, id, controller.signal);
      await writer`INSERT INTO code.job_calls(id,job_id,generation,operation,input) VALUES(${id}::uuid,${f.job.id}::uuid,${f.lease.generation},'chat.message',${JSON.stringify(await encodeChatValue({ type: "output", value: "hello" }))})`;
      const event = await meter.during(async () => {
        notifyChatRun(f.job.id, "mailbox");
        await replyWake.wait();
      });
      replyWake.close();
      expect(polls()).toBe(initial + 1);
      expect(event.filter((statement) => statement.startsWith("SELECT state,result,generation,call_bytes"))).toHaveLength(2); // poll and resolve
      expect(event).toHaveLength(10); // existing durable claim + resolution transactions
      expect(await tool("code_inspect", { runId: "remote-run" })).toMatchObject({ output: '"hello"' });
      // No hint: the next fallback still delivers a committed message exactly once.
      const lostId = crypto.randomUUID();
      const recovered = Promise.withResolvers<void>();
      resolutions.set(lostId, recovered.resolve);
      await writer`INSERT INTO code.job_calls(id,job_id,generation,operation,input) VALUES(${lostId}::uuid,${f.job.id}::uuid,${f.lease.generation},'chat.message',${JSON.stringify(await encodeChatValue({ type: "output", value: "recovered" }))})`;
      await recovered.promise;
      const [stored] = await writer`SELECT state FROM code.job_calls WHERE id=${lostId}::uuid`;
      expect(stored!.state).toBe("done");
      const hints = spyOn(notifications, "notifyChatRun");
      try {
        await completeCodeJob(f.lease, { kind: "chat", outcome: "succeeded" });
        expect(hints).toHaveBeenCalledWith(f.job.id, "status");
      } finally {
        hints.mockRestore();
      }
      await terminal.promise;
      const terminalPolls = polls();
      await Bun.sleep(350);
      expect(polls()).toBe(terminalPolls);
    } finally {
      controller.abort();
      await host.close();
      await meter.close();
      await writer.close();
    }
  });
});
