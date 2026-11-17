import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, redis, sql, unbindProcessSync } from "@k2b/cloud";
import { applyCodeOutputEvent, emptyCodeOutput } from "@k2b/cloud/code";
import { type CodeRunTokenClaims, signCodeRunToken } from "@k2b/cloud/code/run-token";
import { RUNNER_PATHS, RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import { LIVE_LIMITS } from "@k2b/cloud/events";
import { accounts } from "@k2b/cloud/services";
import { createSync, type Sync } from "@k2b/sync";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { aiCapabilities } from "../capabilities";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateSettings } from "../migrate/core/settings";
import { codeLiveChannels, publishCodeCallHint } from "./live";
import {
  codeOutputTopic,
  openCodeOutput,
  persistCodeOutput,
  receiveCodeOutput,
  rememberCodeOutputSecrets,
  replayCodeOutput,
} from "./output";
import { createCodeRunnerRoutes } from "./runner-routes";
import { expireCodeRuns, readCodeRun } from "./store";

const owner = "11111111-1111-4111-8111-111111111111";
const reader = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const fixed = Date.UTC(2030, 0, 2);
const codeId = "c_outputtest";
suiteFor(
  "database",
  "nats",
  "valkey",
)("Code output: bounded, private, replayable and DATA-13", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let versionId: string;
  let claims: CodeRunTokenClaims;
  let outputRoutes: ReturnType<typeof createCodeRunnerRoutes>;
  let token: string;
  const clearFixture = () =>
    redis.send("DEL", [
      `core:code-output:v1:${runId}`,
      ...[1, 2].flatMap((generation) => [
        `core:code-output:v1:${runId}:lease:${generation}`,
        `core:code-output:v1:${runId}:secrets:${generation}`,
      ]),
    ]);
  const batch = (seq: number, text: string) => ({ seq, lines: [{ level: "log" as const, text }], droppedLines: 0, droppedBytes: 0 });
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("code_output");
    await clearFixture();
    connection = await connectTestNats();
    sync = createSync({ connection, namespace: testSyncNamespace("code-output"), application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync, connection);
    await sync.ready();
    for (const migrate of [migrateAuth, migrateEvents, migrateSettings, migrateCode, migrateScheduling]) await migrate();
    for (const [uid, id] of Object.entries({ owner, reader }))
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${uid},'local','user')`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Output fixture')`;
    const [version] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,'{}'::jsonb,'fixture',${"a".repeat(64)},${"b".repeat(64)},2,7,${owner}::uuid) RETURNING id`;
    versionId = version!.id;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit,state)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'manual','run',32768,200,'running')`;
    await sql`WITH added AS (INSERT INTO auth.access(user_id,permission) VALUES(${reader}::uuid,'read') RETURNING id)
      INSERT INTO code.shares(code_id,access_id) SELECT ${codeId},id FROM added`;
    claims = {
      ver: 1,
      token_use: "code_run",
      iss: "https://cloud.example",
      aud: "cloud-code-bridge",
      iat: fixed / 1000,
      nbf: fixed / 1000,
      exp: fixed / 1000 + 300,
      codeId,
      versionId,
      entrypoint: "run",
      runId,
      generation: 1,
      mandateId: "44444444-4444-4444-8444-444444444444",
      mandateRevision: 1,
      bundleHash: "b".repeat(64),
    };
    const pair = await generateKeyPair("RS256", { extractable: true });
    const kid = "55555555-5555-4555-8555-555555555555";
    token = await signCodeRunToken(claims, {
      issuer: claims.iss,
      deadlineAt: claims.exp * 1000,
      now: new Date(fixed),
      signer: { kid, key: pair.privateKey, signUntil: new Date(claims.exp * 1000) },
    });
    outputRoutes = createCodeRunnerRoutes({
      token: {
        issuer: claims.iss,
        now: new Date(fixed),
        key: createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig", kid }] }),
      },
    });
    await openCodeOutput({ runId, codeId, generation: 1, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 }, 32768);
  });
  afterAll(async () => {
    setSystemTime();
    await clearFixture();
    unbindProcessSync();
    await sync?.drain();
    await connection?.drain();
    await database?.drop();
  });
  test("call hints cost zero SQL; every output batch costs zero SQL; the final window costs one write", async () => {
    const meter = await meterSql();
    try {
      expect(
        await meter.during(() =>
          publishCodeCallHint(codeId, { type: "code.call", runId, ordinal: 1, operation: "example.read", state: "running" }),
        ),
      ).toEqual([]);
      await rememberCodeOutputSecrets(claims, [{ name: "TOKEN", value: "private-token", sent: "Bearer private-token" }]);
      const request = (proof: { token: string; runId: string; generation: number }, text: string) =>
        outputRoutes.request(RUNNER_PATHS.output, {
          method: "POST",
          body: JSON.stringify({ ...proof, batch: batch(1, text) }),
          headers: { "Content-Type": "application/json" },
        });
      expect(
        await meter.during(async () => {
          expect((await request({ token: "forged", runId, generation: 1 }, "refused")).status).toBe(403);
          expect((await request({ token, runId, generation: 2 }, "wrong attempt")).status).toBe(409);
          expect((await request({ token, runId, generation: 1 }, "first private-token")).status).toBe(204);
        }),
      ).toEqual([]);
      // Above cadence: count, discard, do not send another live bundle.
      expect(await meter.during(() => receiveCodeOutput(claims, batch(2, "discarded")))).toEqual([]);
      setSystemTime(fixed + 1000);
      expect(await meter.during(() => receiveCodeOutput(claims, batch(3, "last")))).toEqual([]);
      const tail = await replayCodeOutput(runId);
      expect(tail.lines).toEqual([
        {
          level: "log",
          parts: [
            { type: "text", text: "first " },
            { type: "secret", name: "TOKEN" },
          ],
        },
        { level: "log", parts: [{ type: "text", text: "last" }] },
      ]);
      expect(tail.droppedLines).toBe(1);
      expect(tail.droppedBytes).toBeGreaterThan(0);
      expect(await meter.during(() => receiveCodeOutput(claims, batch(3, "duplicate must not append")))).toEqual([]);
      expect(await replayCodeOutput(runId)).toEqual(tail);
      // The topic alone replays the accepted lines; cumulative counters cover rate-discarded input too.
      let replay = emptyCodeOutput();
      for await (const event of codeOutputTopic().replay({ tenantId: runId })) replay = applyCodeOutputEvent(replay, event.data);
      expect(replay).toEqual(tail);
      const unavailable = spyOn(codeOutputTopic(), "replay").mockImplementation(async function* () {
        throw new Error("broker unavailable");
      });
      try {
        expect(
          await meter.during(async () => {
            expect(await replayCodeOutput(runId)).toEqual(tail);
          }),
        ).toEqual([]);
      } finally {
        unavailable.mockRestore();
      }
      const writes = await meter.during(() => persistCodeOutput(runId));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/UPDATE code.runs SET console_output=/);
      const [saved] = await sql<{ console_output: unknown }[]>`SELECT console_output FROM code.runs WHERE id=${runId}::uuid`;
      expect(saved!.console_output).toEqual(tail);
      await expect(receiveCodeOutput(claims, batch(4, "after terminal"))).rejects.toBeInstanceOf(RunnerLeaseLostError);
    } finally {
      await meter.close();
    }
  });
  test("readers receive no contents through the shared service and capability used by API, CLI and agents", async () => {
    for (const id of [owner, reader]) {
      const user = await accounts.users.get({ id });
      if (!user) throw new Error("Missing output fixture user");
      const authority = {
        actor: { kind: "user" as const, user },
        accessSubject: { type: "user" as const, userId: id },
        credentialKind: "session" as const,
        scopes: [],
      };
      const context = { authority };
      const result = await readCodeRun({ codeId, runId }, context);
      expect(result.contents === null).toBe(id === reader);
      for (const origin of ["http", "assistant", "mcp"] as const) {
        const capability = await aiCapabilities.queries["code.run.read"].run(
          { codeId, runId, cursor: 0, offset: 0, length: 16_384 },
          {
            ...context,
            actor: authority.actor,
            accessSubject: authority.accessSubject,
            user,
            requestId: "fixture",
            locale: "en",
            origin,
            signal: new AbortController().signal,
          },
        );
        if (!capability.ok) throw new Error("Run read capability failed");
        expect(capability.data.data.contents === null).toBe(id === reader);
      }
      const who = { id: `user:${id}`, actor: authority.actor, accessSubject: authority.accessSubject, scopes: [] };
      expect((await codeLiveChannels.codeDetails.authorize(`code.details:${codeId}`, [who])).has(who.id)).toBe(id === owner);
    }
  });
  test("stale generations cannot publish into a newer attempt and earlier output is reset", async () => {
    await openCodeOutput({ runId, codeId, generation: 2, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 }, 32768);
    await expect(receiveCodeOutput(claims, batch(5, "stale"))).rejects.toBeInstanceOf(RunnerLeaseLostError);
    const newer = { ...claims, generation: 2 };
    await receiveCodeOutput(newer, batch(1, "new attempt"));
    expect((await replayCodeOutput(runId)).lines).toEqual([{ level: "log", parts: [{ type: "text", text: "new attempt" }] }]);
    // Newline expansion adds structured per-line overhead. Both the broker frame
    // and the retained tail must stay bounded after that expansion, with counted loss.
    for (let seq = 2; seq <= 4; seq++) {
      setSystemTime(fixed + seq * 1000);
      await receiveCodeOutput(newer, batch(seq, "x\n".repeat(LIVE_LIMITS.frameBytes / 4)));
    }
    const tail = await replayCodeOutput(runId);
    expect(Buffer.byteLength(JSON.stringify(tail.lines))).toBeLessThanOrEqual(32768);
    expect(tail.droppedLines).toBeGreaterThan(0);
    expect(tail.droppedBytes).toBeGreaterThan(0);
    let replay = emptyCodeOutput();
    for await (const event of codeOutputTopic().replay({ tenantId: runId })) {
      expect(Buffer.byteLength(JSON.stringify(event.data))).toBeLessThanOrEqual(LIVE_LIMITS.frameBytes);
      replay = applyCodeOutputEvent(replay, event.data);
    }
    expect(replay).toEqual(tail);
  });
  test("30-day expiry deletes the stored output with its run", async () => {
    await sql`UPDATE code.runs SET state='succeeded',ended_at='2029-12-01T00:00:00Z' WHERE id=${runId}::uuid`;
    expect(await expireCodeRuns({ now: new Date(fixed), limit: 100 })).toBe(1);
    expect(await sql`SELECT console_output FROM code.runs WHERE id=${runId}::uuid`).toHaveLength(0);
  });
});
