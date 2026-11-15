import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { LiveViewer } from "@k2b/cloud/events";
import { createLiveEngine, LIVE_LIMITS, type LiveEnvelope, liveOutbox, liveTopicConfig } from "@k2b/cloud/events/testing";
import { accounts } from "@k2b/cloud/services";
import { createSync, type Sync, type Topic } from "@k2b/sync";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";

/** The hint Core publishes on its `code` channel, as browsers parse it. */
const CodeRunEventSchema = z.object({ type: z.literal("code.run"), runId: z.uuid(), state: z.string(), at: z.string() }).strict();

import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateCodeLive } from "../migrate/core/code-live";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateSettings } from "../migrate/core/settings";
import { codeLiveChannels } from "./live";
import { appendCodeCall, finishCodeCall } from "./store";

const owner = "11111111-1111-4111-8111-111111111111";
const reader = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";
const codeId = "c_livetest";
const runId = "44444444-4444-4444-8444-444444444444";
const fixed = new Date("2026-11-14T12:00:00.000Z");

suiteFor(
  "database",
  "nats",
  "valkey",
)("Core Code run live updates (DATA-13)", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let topic: Topic<LiveEnvelope>;
  let versionId: string;
  const viewer = async (id: string): Promise<LiveViewer> => {
    const user = await accounts.users.get({ id });
    if (!user) throw new Error("Missing live fixture user");
    return { id: `user:${id}`, actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, scopes: [] };
  };
  const hints = () => sql<{ payload: LiveEnvelope }[]>`SELECT payload FROM events.outbox
    WHERE app_id='core' AND kind='live' AND ordering_key=${codeId} ORDER BY seq`;
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code_live");
    for (const migrate of [migrateAuth, migrateEvents, migrateSettings, migrateCode, migrateCodeLive]) await migrate();
    // Reapplying the migration removes an earlier draft's per-effect trigger too.
    await sql`CREATE TRIGGER run_live_effect AFTER UPDATE ON code.calls
      FOR EACH ROW EXECUTE FUNCTION code.publish_run_live()`.simple();
    await migrateCodeLive();
    expect(await sql`SELECT tgname FROM pg_trigger WHERE tgrelid='code.calls'::regclass AND tgname='run_live_effect'`).toHaveLength(0);
    for (const [uid, id] of Object.entries({ owner, reader, stranger }))
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${uid},'local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Live fixture')`;
    const [version] = await sql<{ id: string }[]>`INSERT INTO code.versions
      (code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,'{"code.ts":"fixture"}'::jsonb,'fixture',${"a".repeat(64)},${"b".repeat(64)},7,7,${owner}::uuid) RETURNING id`;
    versionId = version!.id;
    connection = await connectTestNats();
    sync = createSync({ connection, namespace: testSyncNamespace("code-runs-live"), application: "core", defaults: { replicas: 1 } });
    topic = sync.topic<LiveEnvelope>(liveTopicConfig("core"));
    await sync.ready();
  });
  beforeEach(async () => {
    await sql`WITH added AS (
      INSERT INTO auth.access(user_id,permission) SELECT ${reader}::uuid,'read'::auth.permission_level
      WHERE NOT EXISTS(SELECT FROM code.shares j JOIN auth.access a ON a.id=j.access_id
        WHERE j.code_id=${codeId} AND a.user_id=${reader}::uuid) RETURNING id)
      INSERT INTO code.shares(code_id,access_id) SELECT ${codeId},id FROM added`;
    await sql`DELETE FROM events.outbox`;
  });
  afterAll(async () => {
    setSystemTime();
    await sync?.drain();
    await connection?.drain();
    await database?.drop();
  });

  test("only admission and run state changes enqueue payload-free hints; confirmed effects wait for completion", async () => {
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'manual','run',32768,10)`;
    await sql`UPDATE code.runs SET state='running',started_at=clock_timestamp() WHERE id=${runId}::uuid`;
    const beforeCalls = await hints();
    const ordinal = await sql.begin((tx) =>
      appendCodeCall(
        {
          runId,
          kind: "action",
          call: { capability: "example.send", target: null, refs: {}, input: {} },
        },
        tx,
      ),
    );
    await sql.begin((tx) =>
      finishCodeCall({ runId, ordinal, state: "succeeded", result: { ok: true }, confirmedEffect: true, endedAt: new Date() }, tx),
    );
    expect(await hints()).toEqual(beforeCalls);
    await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp() WHERE id=${runId}::uuid`;
    const rows = await hints();
    expect(rows.map(({ payload }) => CodeRunEventSchema.parse(payload.d).state)).toEqual(["queued", "running", "succeeded"]);
    for (const { payload } of rows) {
      expect(payload.k).toBe(codeId);
      expect(CodeRunEventSchema.parse(payload.d).runId).toBe(runId);
    }
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE code.runs SET state='failed' WHERE id=${runId}::uuid`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await hints()).toEqual(rows);
    const after = await topic.head();
    const outbox = liveOutbox("core", (row) => topic.publish({ data: row.payload, orderingKey: row.ordering_key, idempotencyKey: row.id }));
    try {
      await outbox.reconcile();
      const delivered: LiveEnvelope[] = [];
      for await (const event of topic.replay({ after })) delivered.push(event.data);
      expect(delivered).toEqual(rows.map((row) => row.payload));
    } finally {
      await outbox.stop();
    }
  });

  test("only the owner and shared readers are admitted; scoped credentials keep their ceiling", async () => {
    const who = await Promise.all([viewer(owner), viewer(reader), viewer(stranger)]);
    const denied = { ...who[0]!, id: `user:${owner}:scopes=`, scopes: [] };
    expect(await codeLiveChannels.code.authorize(codeId, [...who, denied])).toEqual(new Set(who.slice(0, 2).map((person) => person.id)));
    expect(await codeLiveChannels.code.authorize("c_missing", who)).toEqual(new Set());
  });

  test("NATS fan-out and progress issue zero SQL beyond the delivery cache lifetime; share removal revokes before later data", async () => {
    const who = await viewer(reader);
    const progressMs = LIVE_LIMITS.progressMs;
    LIVE_LIMITS.progressMs = 25;
    const engine = createLiveEngine({ appId: "core", topic: () => topic, channels: codeLiveChannels });
    const frames: { t: string; data?: unknown }[][] = [[], [], []];
    const meter = await meterSql();
    try {
      const setup = await meter.during(async () => {
        for (const received of frames) {
          const socket = engine.open(
            { send: (frame) => received.push(JSON.parse(frame)), close: () => {}, getBufferedAmount: () => 0 },
            who,
            async () => who,
          );
          socket.message(JSON.stringify({ t: "sub", id: "runs", channel: "code", scope: { codeId }, after: await topic.head() }));
        }
        await until(() => frames.every((received) => received.some((frame) => frame.t === "ready")));
      });
      // One Code lookup and one batched share lookup per admission, shared where the engine can reuse them.
      expect(setup.length).toBeGreaterThan(0);
      expect(setup.length).toBeLessThanOrEqual(6);
      for (let index = 0; index < 3; index++) {
        setSystemTime(fixed.getTime() + (index + 1) * 60_000);
        const statements = await meter.during(async () => {
          await topic.publish({ data: { v: 1, k: codeId, d: { type: "code.run", runId, state: "succeeded", at: fixed.toISOString() } } });
          await until(() => frames.every((received) => received.filter((frame) => frame.t === "event").length === index + 1));
        });
        expect({ perEvent: statements.length, statements }).toEqual({ perEvent: 0, statements: [] });
      }
      expect(
        await meter.during(async () => {
          const before = frames.map((received) => received.filter((frame) => frame.t === "progress").length);
          await until(() => frames.every((received, index) => received.filter((frame) => frame.t === "progress").length > before[index]!));
        }),
      ).toEqual([]);
      const outbox = liveOutbox("core", (row) =>
        topic.publish({ data: row.payload, orderingKey: row.ordering_key, idempotencyKey: row.id }),
      );
      try {
        await sql`DELETE FROM code.shares WHERE code_id=${codeId}`;
        expect((await hints()).some(({ payload }) => payload.a)).toBe(true);
        await outbox.reconcile();
        await until(() => frames.every((received) => received.some((frame) => frame.t === "revoked")));
        await topic.publish({ data: { v: 1, k: codeId, d: { type: "code.run", runId, state: "failed", at: fixed.toISOString() } } });
        await connection.flush();
        await Bun.sleep(30);
        expect(frames.every((received) => received.filter((frame) => frame.t === "event").length === 3)).toBe(true);
      } finally {
        await outbox.stop();
      }
    } finally {
      engine.stop();
      LIVE_LIMITS.progressMs = progressMs;
      setSystemTime(fixed);
      await meter.close();
    }
  });
});

async function until(ready: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("Live fixture timed out");
    await Bun.sleep(5);
  }
}
