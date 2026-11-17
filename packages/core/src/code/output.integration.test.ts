import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, redis, sql, unbindProcessSync } from "@k2b/cloud";
import { applyCodeOutputEvent, emptyCodeOutput, isCodeOutputLogEntry } from "@k2b/cloud/code";
import { type CodeRunTokenClaims, signCodeRunToken } from "@k2b/cloud/code/run-token";
import { RUNNER_PATHS, RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import { LIVE_LIMITS } from "@k2b/cloud/events";
import { accounts } from "@k2b/cloud/services";
import { createSync, type Sync } from "@k2b/sync";
import { generateKeyPair } from "jose";
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
  closeCodeOutput,
  codeOutputTopic,
  openCodeOutput,
  persistCodeOutput,
  receiveCodeOutput,
  rememberCodeOutputSecrets,
  renewCodeOutput,
  replayCodeOutput,
} from "./output";
import * as redaction from "./output-redaction";
import { createCodeRunnerRoutes } from "./runner-routes";
import { secretEchoReplacements } from "./secret-echo";
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
  const extraRuns: string[] = [];
  const clearFixture = () =>
    redis.send("DEL", [
      ...extraRuns.flatMap((id) => [
        `core:code-output:v1:${id}`,
        `core:code-output:v1:${id}:lease:1`,
        `core:code-output:v1:${id}:secrets:1`,
        `core:code-output:v1:${id}:drops:1`,
      ]),
      `core:code-output:v1:${runId}`,
      ...[1, 2].flatMap((generation) => [
        `core:code-output:v1:${runId}:lease:${generation}`,
        `core:code-output:v1:${runId}:secrets:${generation}`,
        `core:code-output:v1:${runId}:drops:${generation}`,
      ]),
    ]);
  const batch = (seq: number, text: string) => ({
    seq,
    entries: [{ kind: "log" as const, at: new Date().toISOString(), level: "log" as const, text }],
    droppedLines: 0,
    droppedBytes: 0,
  });
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
    // No verifier overrides: pin the complete production HTTP path, even cold.
    outputRoutes = createCodeRunnerRoutes();
    await openCodeOutput({ runId, codeId, token, generation: 1, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 }, 32768);
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
          // Entry-policy exemption does not authorize an output request without its lease proof.
          const missingProof = await outputRoutes.request(RUNNER_PATHS.output, {
            method: "POST",
            body: JSON.stringify({ batch: batch(1, "refused") }),
            headers: { "Content-Type": "application/json" },
          });
          expect(missingProof.status).toBe(400);
          expect((await request({ token: "forged", runId, generation: 1 }, "refused")).status).toBe(409);
          expect((await request({ token, runId: "66666666-6666-4666-8666-666666666666", generation: 1 }, "wrong run")).status).toBe(409);
          expect((await request({ token, runId, generation: 2 }, "wrong attempt")).status).toBe(409);
          expect((await request({ token, runId, generation: 1 }, "first private-token")).status).toBe(204);
        }),
      ).toEqual([]);
      // Above cadence: count, discard, do not send another live bundle.
      expect(await meter.during(() => receiveCodeOutput({ token, runId, generation: 1 }, batch(2, "discarded")))).toEqual([]);
      setSystemTime(fixed + 1000);
      expect(await meter.during(() => receiveCodeOutput({ token, runId, generation: 1 }, batch(3, "last")))).toEqual([]);
      const tail = await replayCodeOutput(runId);
      expect(tail.entries).toEqual([
        {
          id: "1:1:0",
          kind: "log" as const,
          at: new Date(fixed).toISOString(),
          level: "log",
          text: [
            { type: "text", text: "first " },
            { type: "secret", name: "TOKEN" },
          ],
        },
        { id: "1:2:0", kind: "log" as const, at: new Date().toISOString(), level: "log", text: [{ type: "text", text: "last" }] },
      ]);
      expect(tail.droppedLines).toBe(1);
      expect(tail.droppedBytes).toBeGreaterThan(0);
      expect(await meter.during(() => receiveCodeOutput({ token, runId, generation: 1 }, batch(3, "duplicate must not append")))).toEqual(
        [],
      );
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
      await expect(receiveCodeOutput({ token, runId, generation: 1 }, batch(4, "after terminal"))).rejects.toBeInstanceOf(
        RunnerLeaseLostError,
      );
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
    const newerToken = `${token}.next-attempt`;
    await openCodeOutput(
      { runId, codeId, token: newerToken, generation: 2, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 },
      32768,
    );
    await expect(receiveCodeOutput({ token, runId, generation: 1 }, batch(5, "stale"))).rejects.toBeInstanceOf(RunnerLeaseLostError);
    await expect(receiveCodeOutput({ token, runId, generation: 2 }, batch(1, "old token, current generation"))).rejects.toBeInstanceOf(
      RunnerLeaseLostError,
    );
    const newer = { token: newerToken, runId, generation: 2 };
    await receiveCodeOutput(newer, batch(1, "too soon in the same run"));
    expect((await replayCodeOutput(runId)).entries).toEqual([]);
    expect((await replayCodeOutput(runId)).droppedLines).toBe(1);
    setSystemTime(fixed + 2000);
    await receiveCodeOutput(newer, batch(2, "new attempt"));
    expect((await replayCodeOutput(runId)).entries).toEqual([
      { id: "2:1:0", kind: "log" as const, at: new Date().toISOString(), level: "log", text: [{ type: "text", text: "new attempt" }] },
    ]);
    // Newline expansion adds structured per-line overhead. Both the broker frame
    // and the retained tail must stay bounded after that expansion, with counted loss.
    for (let seq = 3; seq <= 5; seq++) {
      setSystemTime(fixed + seq * 1000);
      await receiveCodeOutput(newer, batch(seq, "x\n".repeat(LIVE_LIMITS.frameBytes / 4)));
    }
    const tail = await replayCodeOutput(runId);
    expect(Buffer.byteLength(JSON.stringify(tail.entries))).toBeLessThanOrEqual(32768);
    expect(tail.droppedLines).toBeGreaterThan(0);
    expect(tail.droppedBytes).toBeGreaterThan(0);
    let replay = emptyCodeOutput();
    for await (const event of codeOutputTopic().replay({ tenantId: runId })) {
      expect(Buffer.byteLength(JSON.stringify(event.data))).toBeLessThanOrEqual(LIVE_LIMITS.frameBytes);
      replay = applyCodeOutputEvent(replay, event.data);
    }
    expect(replay).toEqual(tail);
  });
  async function attempt(budget = 32768) {
    const id = `77777777-7777-4777-8777-${String(extraRuns.length + 1).padStart(12, "0")}`;
    extraRuns.push(id);
    await redis.send("DEL", [
      `core:code-output:v1:${id}`,
      `core:code-output:v1:${id}:lease:1`,
      `core:code-output:v1:${id}:secrets:1`,
      `core:code-output:v1:${id}:drops:1`,
    ]);
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit,state,generation)
      VALUES(${id}::uuid,${codeId},${versionId}::uuid,'manual','run',${budget},200,'running',1)`;
    const proof = { runId: id, generation: 1, token: `fixture-${id}` };
    await openCodeOutput({ ...proof, codeId, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 }, budget);
    return proof;
  }
  test("harden output continuity and finalization across transport boundaries", async () => {
    const value = 'abcdefgh /+"value';
    const inserted = [{ name: "TOKEN", value, sent: `Bearer ${value}` }];
    for (const spelling of secretEchoReplacements(inserted).keys()) {
      setSystemTime(fixed);
      const proof = await attempt();
      await rememberCodeOutputSecrets({ ...claims, ...proof }, inserted);
      const middle = Math.floor(spelling.length / 2);
      await receiveCodeOutput(proof, batch(1, spelling.slice(0, middle)));
      expect((await replayCodeOutput(proof.runId)).entries.filter(isCodeOutputLogEntry).flatMap((line) => line.text)).toEqual([]);
      const raw = await redis.get(`core:code-output:v1:${proof.runId}`);
      expect(raw).not.toContain(spelling.slice(0, middle));
      setSystemTime(fixed + 1000);
      await receiveCodeOutput(proof, batch(2, spelling.slice(middle)));
      // An unpadded spelling can still prefix a padded spelling; finalization resolves it.
      await persistCodeOutput(proof.runId);
      expect((await replayCodeOutput(proof.runId)).entries.filter(isCodeOutputLogEntry).flatMap((line) => line.text)).toEqual([
        { type: "secret", name: "TOKEN" },
      ]);
    }
    setSystemTime(fixed);
    const proof = await attempt();
    await rememberCodeOutputSecrets({ ...claims, ...proof }, inserted);
    await receiveCodeOutput(proof, batch(1, "abcd"));
    const meter = await meterSql();
    try {
      expect(await meter.during(() => persistCodeOutput(proof.runId))).toHaveLength(1);
    } finally {
      await meter.close();
    }
    expect((await replayCodeOutput(proof.runId)).entries).toEqual([
      { id: "1:2:0", kind: "log" as const, at: new Date().toISOString(), level: "log", text: [{ type: "secret", name: "TOKEN" }] },
    ]);
  });
  test("harden bounded replacement admission, deduplication and compiled revision reuse", async () => {
    setSystemTime(fixed);
    const budget = LIVE_LIMITS.frameBytes;
    const proof = await attempt(budget);
    const scoped = { ...claims, ...proof };
    const entry = { name: "TOKEN", value: "fixture-private-value", sent: "Bearer fixture-private-value" };
    const compile = spyOn(redaction, "compileOutputRedaction");
    try {
      await rememberCodeOutputSecrets(scoped, [entry]);
      const key = `core:code-output:v1:${proof.runId}:secrets:1`;
      const before = await redis.send("HGETALL", [key]);
      await receiveCodeOutput(proof, batch(1, "ordinary"));
      expect(compile).toHaveBeenCalledTimes(1);
      await rememberCodeOutputSecrets(scoped, [entry]);
      expect(await redis.send("HGETALL", [key])).toEqual(before);
      setSystemTime(fixed + 1000);
      await receiveCodeOutput(proof, batch(2, "ordinary"));
      expect(compile).toHaveBeenCalledTimes(1);
      await rememberCodeOutputSecrets(scoped, [{ ...entry, sent: `Other ${entry.value}` }]);
      setSystemTime(fixed + 2000);
      await receiveCodeOutput(proof, batch(3, "ordinary"));
      expect(compile).toHaveBeenCalledTimes(2);
      await expect(rememberCodeOutputSecrets(scoped, [{ ...entry, sent: "x".repeat(budget) }])).rejects.toMatchObject({
        code: "code_http_output_redaction_limit",
      });
      expect(Number(await redis.send("HGET", [key, "bytes"]))).toBeLessThanOrEqual(budget);
      const fields = await redis.send("HGETALL", [key]);
      expect(Buffer.byteLength(JSON.stringify(fields))).toBeLessThan(budget);
      // Required earlier entries remain available after a refused addition.
      setSystemTime(fixed + 3000);
      await receiveCodeOutput(proof, batch(4, entry.value));
      expect(
        (await replayCodeOutput(proof.runId)).entries
          .filter(isCodeOutputLogEntry)
          .flatMap((line) => line.text)
          .at(-1),
      ).toEqual({ type: "secret", name: "TOKEN" });
    } finally {
      compile.mockRestore();
    }
  });
  test("harden replacement-cache recovery while preserving masked final fragments", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    const scoped = { ...claims, ...proof };
    const entry = { name: "TOKEN", value: "fixture-private-value", sent: "Bearer fixture-private-value" };
    await rememberCodeOutputSecrets(scoped, [entry]);
    await receiveCodeOutput(proof, batch(1, "fixt"));
    await redis.send("DEL", [`core:code-output:v1:${proof.runId}:secrets:1`]);
    setSystemTime(fixed + 1000);
    const meter = await meterSql();
    try {
      expect(
        await meter.during(async () => {
          await expect(receiveCodeOutput(proof, batch(2, "ure-private-value"))).rejects.toThrow("code_output_redaction_unavailable");
        }),
      ).toEqual([]);
    } finally {
      await meter.close();
    }
    await expect(rememberCodeOutputSecrets(scoped, [entry])).rejects.toMatchObject({ code: "code_http_output_redaction_unavailable" });
    await persistCodeOutput(proof.runId);
    expect((await replayCodeOutput(proof.runId)).entries).toEqual([
      { id: "1:2:0", kind: "log" as const, at: new Date(fixed).toISOString(), level: "log", text: [{ type: "secret", name: "TOKEN" }] },
    ]);
  });
  test("harden above-cadence counters without rewriting the retained window or compiling replacements", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    await receiveCodeOutput(proof, batch(1, "first"));
    const raw = await redis.get(`core:code-output:v1:${proof.runId}`);
    const compile = spyOn(redaction, "compileOutputRedaction");
    try {
      const meter = await meterSql();
      try {
        expect(await meter.during(() => receiveCodeOutput(proof, batch(2, "discarded")))).toEqual([]);
      } finally {
        await meter.close();
      }
      expect(await redis.get(`core:code-output:v1:${proof.runId}`)).toBe(raw);
      expect(compile).not.toHaveBeenCalled();
      expect((await replayCodeOutput(proof.runId)).droppedLines).toBe(1);
      setSystemTime(fixed + 1000);
      await receiveCodeOutput(proof, batch(2, "discarded"));
      expect(await redis.get(`core:code-output:v1:${proof.runId}`)).toBe(raw);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });
  test("harden closed fences against renewal and delayed admission while retaining replay", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    await receiveCodeOutput(proof, batch(1, "retained"));
    await closeCodeOutput(proof.runId, 1);
    await renewCodeOutput({ ...claims, ...proof }, fixed + 300_000);
    await openCodeOutput({ ...proof, codeId, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 }, 32768);
    await expect(receiveCodeOutput(proof, batch(2, "closed"))).rejects.toBeInstanceOf(RunnerLeaseLostError);
    expect((await replayCodeOutput(proof.runId)).entries).toEqual([
      { id: "1:1:0", kind: "log" as const, at: new Date().toISOString(), level: "log", text: [{ type: "text", text: "retained" }] },
    ]);
    const delayed = await attempt();
    await redis.send("DEL", [`core:code-output:v1:${delayed.runId}`, `core:code-output:v1:${delayed.runId}:lease:1`]);
    await closeCodeOutput(delayed.runId, 1);
    await openCodeOutput({ ...delayed, codeId, deadlineAt: fixed + 300_000, leaseExpiresAt: fixed + 300_000 }, 32768);
    await expect(receiveCodeOutput(delayed, batch(1, "delayed"))).rejects.toBeInstanceOf(RunnerLeaseLostError);
  });
  test("the pinned proof expires at the immutable run deadline, without SQL", async () => {
    setSystemTime(fixed + 300_000);
    const meter = await meterSql();
    try {
      expect(
        await meter.during(async () => {
          const response = await outputRoutes.request(RUNNER_PATHS.output, {
            method: "POST",
            body: JSON.stringify({ token: `${token}.next-attempt`, runId, generation: 2, batch: batch(6, "too late") }),
            headers: { "Content-Type": "application/json" },
          });
          expect(response.status).toBe(409);
        }),
      ).toEqual([]);
    } finally {
      await meter.close();
      setSystemTime(fixed);
    }
  });
  test("30-day expiry deletes the stored output with its run", async () => {
    await sql`UPDATE code.runs SET state='succeeded',ended_at='2029-12-01T00:00:00Z' WHERE id=${runId}::uuid`;
    expect(await expireCodeRuns({ now: new Date(fixed), limit: 100 })).toBe(1);
    expect(await sql`SELECT console_output FROM code.runs WHERE id=${runId}::uuid`).toHaveLength(0);
  });
});
