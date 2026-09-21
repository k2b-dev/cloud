import { expect, test } from "bun:test";
import type { LoopAggregate } from "@k2b/nessi";
import { SQL } from "bun";
import { createTurnTimingRecorder, withDurableTurnTiming } from "./turn-timing";

test.skipIf(process.env.ASSISTANT_TIMING_INTEGRATION !== "1")(
  "timing rows survive recorder recreation and exclude persisted approval waits",
  async () => {
    const name = `assistant-timing-test-${crypto.randomUUID()}`;
    const docker = async (...args: string[]) => {
      const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      const [out, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (status) throw new Error(error);
      return out.trim();
    };
    let db: SQL | undefined;
    await docker(
      "run",
      "--detach",
      "--name",
      name,
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "postgres:17-alpine",
    );
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await docker("exec", name, "pg_isready", "-U", "postgres");
          break;
        } catch (error) {
          if (attempt >= 60) throw error;
          await Bun.sleep(100);
        }
      }
      const port = (await docker("port", name, "5432/tcp")).split(":").at(-1);
      db = new SQL(`postgres://postgres@127.0.0.1:${port}/postgres`);
      await db`CREATE SCHEMA ai`;
      await db`CREATE TABLE ai.turns(id uuid PRIMARY KEY,created_at timestamptz,completed_at timestamptz)`;
      await db`CREATE TABLE ai.turn_generation_timings(turn_id uuid,request_id text,started_at timestamptz DEFAULT now(),ended_at timestamptz,PRIMARY KEY(turn_id,request_id))`;
      await db`CREATE TABLE ai.tool_calls(turn_id uuid,call_id text,started_at timestamptz,completed_at timestamptz)`;
      await db`CREATE TABLE ai.pending_actions(turn_id uuid,call_id text,kind text,created_at timestamptz,resolved_at timestamptz)`;
      const id = crypto.randomUUID();
      await db`INSERT INTO ai.turns VALUES(${id}::uuid,'2026-01-01 00:00:00Z','2026-01-01 00:01:00Z')`;
      const start = (turnId: string, resumed = false) => ({
        type: "turn_start" as const,
        turnId,
        turnIndex: turnId === "request-1" ? 0 : 1,
        resumed,
        agentId: "test",
        loopId: "loop",
      });
      const first = createTurnTimingRecorder(id, db);
      await first.event(start("request-1"));
      await first.finishGeneration();
      const resumed = createTurnTimingRecorder(id, db);
      await resumed.event(start("request-1", true));
      await resumed.finishGeneration();
      await resumed.event(start("request-2"));
      await resumed.finishGeneration();
      const rows = await db<{ request_id: string }[]>`SELECT request_id FROM ai.turn_generation_timings ORDER BY request_id`;
      expect(rows.map((row) => row.request_id)).toEqual(["request-1", "request-2"]);
      await db`UPDATE ai.turn_generation_timings SET started_at='2026-01-01 00:00:00Z',ended_at='2026-01-01 00:00:10Z' WHERE request_id='request-1'`;
      await db`UPDATE ai.turn_generation_timings SET started_at='2026-01-01 00:00:50Z',ended_at='2026-01-01 00:01:00Z' WHERE request_id='request-2'`;
      await db`INSERT INTO ai.tool_calls VALUES(${id}::uuid,'tool','2026-01-01 00:00:10Z','2026-01-01 00:00:50Z')`;
      await db`INSERT INTO ai.pending_actions VALUES(${id}::uuid,'tool:approval','custom_approval','2026-01-01 00:00:20Z','2026-01-01 00:00:40Z')`;
      const aggregate: LoopAggregate = {
        turns: [],
        assistantMessageCount: 2,
        toolCallCount: 1,
        toolErrorCount: 0,
        toolIssueCount: 0,
        toolMalformedCount: 0,
        toolCancelledCount: 0,
        toolIssues: [],
        issueCount: 0,
        issues: [],
        usage: { input: 100, output: 600, total: 700 },
      };
      expect((await withDurableTurnTiming(id, aggregate, db)).timing).toEqual({
        wallMs: 60000,
        totalElapsedMs: 60000,
        generationMs: 20000,
        toolExecutionMs: 20000,
        actionWaitMs: 20000,
        outputTokensPerSecond: 30,
      });
      await db`UPDATE ai.turn_generation_timings SET ended_at=NULL WHERE request_id='request-2'`;
      expect((await withDurableTurnTiming(id, aggregate, db)).timing).toBeUndefined();
    } finally {
      await db?.close();
      await docker("rm", "--force", "--volumes", name);
    }
  },
  30000,
);
