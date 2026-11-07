import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import * as execution from "@k2b/cloud/ai";
import { RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate/core/code-jobs";
import { createChatRunnerRoutes } from "./chat-runner";
import { claimCodeJob, fenceCodeJob, heartbeatCodeJob, reconcileCodeJobs } from "./runner-jobs";
import { codeSettings } from "./settings";

suiteFor("database")("chat runner mailbox fencing", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const owner = "11111111-1111-4111-8111-111111111111";
  const conversation = "22222222-2222-4222-8222-222222222222";
  const turn = "33333333-3333-4333-8333-333333333333";
  beforeAll(async () => {
    database = await useFreshDatabase("chat_runner_mailbox");
    await sql`CREATE SCHEMA code`;
    await migrate();
    // Reconciliation updates this registry only when heartbeating; no runner process is started.
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.jobs`;
  });
  afterAll(async () => {
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
});
