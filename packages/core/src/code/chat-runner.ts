import { sql } from "@k2b/cloud";
import { authorizeCodeExecution } from "@k2b/cloud/ai";
import { CODE_CHECK_LIMITS } from "@k2b/cloud/code";
import { ChatRunInputSchema, ChatRunReplySchema } from "@k2b/cloud/code/chat-run";
import { type RunnerJobCallSchema, RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import { CAPABILITY_MAX_REQUEST_BYTES } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { codeAdmissionLock } from "./admission";
import { fenceCodeJob } from "./runner-jobs";
import { codeSettings } from "./settings";

const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 100);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });

/** Runner proof fences the mailbox; every actual effect remains authorized by the Assistant turn host. */
export async function callChatJob(request: z.infer<typeof RunnerJobCallSchema>, signal: AbortSignal) {
  const job = await fenceCodeJob(request, sql, false);
  if (job.kind !== "chat") throw new RunnerLeaseLostError();
  await authorizeCodeExecution(job.conversation_id, job.turn_id, job.owner_id);
  const admitted = await sql.begin(async (db) => {
    await fenceCodeJob(request, db);
    if (Buffer.byteLength(JSON.stringify(request.input)) > job.call_bytes) throw new Error("code_chat_call_limit");
    const [count] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM code.job_calls WHERE job_id=${request.jobId}::uuid`;
    if (count!.count >= job.calls_limit) {
      await db`UPDATE code.jobs SET state='failed',input=NULL,lease_key_hash=NULL,result='{"kind":"error","code":"code_job_call_limit"}'::jsonb WHERE id=${request.jobId}::uuid`;
      return false;
    }
    await db`INSERT INTO code.job_calls(id,job_id,generation,operation,input) VALUES(${request.id}::uuid,${request.jobId}::uuid,
      ${request.generation},${request.operation},${JSON.stringify(request.input)})`;
    return true;
  });
  if (!admitted) throw new RunnerLeaseLostError();
  while (!signal.aborted) {
    const result = await sql.begin(async (db) => {
      await fenceCodeJob(request, db, false);
      const [row] = await db<
        { result: string | null }[]
      >`SELECT result FROM code.job_calls WHERE id=${request.id}::uuid AND job_id=${request.jobId}::uuid`;
      return row?.result;
    });
    if (result) return ChatRunReplySchema.parse(JSON.parse(result));
    await pause(signal);
  }
  throw new RunnerLeaseLostError();
}

/** Mounted only behind createCodeCapabilityRoutes' verified, current Assistant-turn continuation. */
export function createChatRunnerRoutes() {
  return new Hono<AuthContext>()
    .onError((error, c) =>
      error instanceof z.ZodError || error instanceof SyntaxError
        ? c.json({ code: "code_invalid_call" }, 400)
        : c.json({ code: "code_runner_unavailable" }, 503),
    )
    .use("*", bodyLimit({ maxSize: CODE_CHECK_LIMITS.requestBytes }))
    .post("/start", async (c) => {
      const input = ChatRunInputSchema.parse(await c.req.json());
      const actor = c.get("actor");
      if (actor.kind !== "user") return c.json({ code: "ACCESS_DENIED" }, 403);
      const encoded = JSON.stringify({ kind: "chat", ...input });
      if (Buffer.byteLength(encoded) > CODE_CHECK_LIMITS.requestBytes) return c.json({ code: "code_job_request_limit" }, 413);
      const queueMax = await codeSettings.get("core.code.job_pending");
      const ownerMax = await codeSettings.get("core.code.concurrency_per_owner");
      const bundleBytes = await codeSettings.get("core.code.bundle_bytes");
      const wallMs = await codeSettings.get("core.code.wall_clock_ms");
      const calls = await codeSettings.get("core.code.calls_per_run");
      const callBytes = CAPABILITY_MAX_REQUEST_BYTES;
      if (Buffer.byteLength(input.bundle) > bundleBytes) return c.json({ code: "code_job_request_limit" }, 413);
      const job = await sql.begin(async (db) => {
        await codeAdmissionLock(db);
        const [count] = await db<{ total: number; own: number }[]>`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE owner_id=${actor.user.id}::uuid)::int AS own FROM code.jobs WHERE state IN('queued','running')`;
        if (count!.total >= queueMax || count!.own >= ownerMax) return null;
        const [row] = await db<
          { id: string; deadline_at: Date }[]
        >`INSERT INTO code.jobs(kind,owner_id,conversation_id,turn_id,input,input_bytes,output_bytes,deadline_at,calls_limit,call_bytes)
          VALUES('chat',${actor.user.id}::uuid,${c.req.param("conversationId")}::uuid,${c.req.param("turnId")}::uuid,
          ${encoded},${Buffer.byteLength(encoded)},${CODE_CHECK_LIMITS.outputBytes},clock_timestamp()+${wallMs}*interval '1 millisecond',${calls},${callBytes}) RETURNING id,deadline_at`;
        return row;
      });
      return job ? c.json({ id: job.id, deadlineAt: job.deadline_at.getTime() }) : c.json({ code: "code_job_busy" }, 429);
    })
    .post("/:id/:operation{poll|resolve|cancel|status}", async (c) => {
      const id = z.uuid().parse(c.req.param("id"));
      const actor = c.get("actor");
      if (actor.kind !== "user") return c.json({ code: "ACCESS_DENIED" }, 403);
      return sql.begin(async (db) => {
        const [job] = await db<
          { state: string; result: unknown; generation: number; call_bytes: number }[]
        >`SELECT state,result,generation,call_bytes FROM code.jobs WHERE id=${id}::uuid
          AND kind='chat' AND owner_id=${actor.user.id}::uuid AND conversation_id=${c.req.param("conversationId")}::uuid
          AND turn_id=${c.req.param("turnId")}::uuid FOR UPDATE`;
        if (!job) return c.json({ code: "code_job_not_found" }, 404);
        if (job.state === "running" || job.state === "queued") {
          const expired = await db`UPDATE code.jobs SET state='failed',input=NULL,lease_key_hash=NULL,
            result='{"kind":"error","code":"code_job_time_limit"}'::jsonb WHERE id=${id}::uuid
            AND (deadline_at<=clock_timestamp() OR (state='running' AND lease_expires_at<=clock_timestamp())) RETURNING id`;
          if (expired.length) {
            job.state = "failed";
            job.result = { kind: "error", code: "code_job_time_limit" };
          }
        }
        const operation = c.req.param("operation");
        if (operation === "cancel") {
          await db`UPDATE code.jobs SET state='cancelled',input=NULL,lease_key_hash=NULL WHERE id=${id}::uuid AND state IN('queued','running')`;
          return c.json({ cancelled: true });
        }
        if (operation === "status") {
          const { id: callId } = z
            .object({ id: z.uuid() })
            .strict()
            .parse(await c.req.json());
          const [call] =
            await db`SELECT id FROM code.job_calls WHERE id=${callId}::uuid AND job_id=${id}::uuid AND generation=${job.generation} AND state='delivering'`;
          return c.json({ active: job.state === "running" && Boolean(call) });
        }
        if (operation === "resolve") {
          const input = z
            .object({ id: z.uuid(), result: ChatRunReplySchema })
            .strict()
            .parse(await c.req.json());
          if (Buffer.byteLength(JSON.stringify(input.result)) > job.call_bytes) return c.json({ code: "code_chat_call_limit" }, 413);
          await db`UPDATE code.job_calls SET state='done',result=${JSON.stringify(input.result)},input=NULL
            WHERE id=${input.id}::uuid AND job_id=${id}::uuid AND generation=${job.generation} AND state='delivering' AND ${job.state}='running'`;
          return c.json({ resolved: true });
        }
        // Delivery is claimed once before effects. A lost Assistant host never replays a mailbox request.
        const calls =
          job.state === "running"
            ? await db<{ id: string; operation: string; input: string }[]>`
          UPDATE code.job_calls SET state='delivering' WHERE job_id=${id}::uuid AND generation=${job.generation} AND state='pending' RETURNING id,operation,input`
            : [];
        return c.json({
          state: job.state,
          result: job.result ?? null,
          calls: calls.map((call) => ({ ...call, input: JSON.parse(call.input) })),
        });
      });
    });
}
