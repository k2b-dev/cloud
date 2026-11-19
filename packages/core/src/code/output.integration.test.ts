import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, redis, sql, unbindProcessSync } from "@k2b/cloud";
import {
  applyCodeOutputEvent,
  CODE_OUTPUT_STEP_LIMITS,
  type CodeOutputBatch,
  CodeOutputBatchSchema,
  codeOutputStepBytes,
  codeRunKey,
  emptyCodeOutput,
  isCodeOutputLogEntry,
  isCodeOutputStepEntry,
} from "@k2b/cloud/code";
import { type CodeRunTokenClaims, signCodeRunToken } from "@k2b/cloud/code/run-token";
import { RUNNER_PATHS, RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import { LIVE_LIMITS } from "@k2b/cloud/events";
import { createLiveEngine, type LiveEnvelope, liveTopicConfig } from "@k2b/cloud/events/testing";
import { accounts } from "@k2b/cloud/services";
import { createSync, type Sync } from "@k2b/sync";
import { generateKeyPair } from "jose";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { RunnerOutput, runnerOutputLimits } from "../../../runner/src/output";
import { aiCapabilities } from "../capabilities";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateCodeLive } from "../migrate/core/code-live";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateSettings } from "../migrate/core/settings";
import * as access from "./access";
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
import { expireCodeRuns, readCodeRun, readCodeRunEntries } from "./store";

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
    for (const migrate of [migrateAuth, migrateEvents, migrateSettings, migrateCode, migrateScheduling, migrateCodeLive]) await migrate();
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
      const entries = await readCodeRunEntries({ codeId, runId }, context);
      expect(entries.output === null).toBe(id === reader);
      if (id === owner) {
        if (!result.contents) throw new Error("Missing owner output");
        expect(entries.output).toEqual(result.contents.consoleOutput);
      }
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
        const ledger = await aiCapabilities.queries["code.run.entries"].run(
          { codeId, runId },
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
        if (!ledger.ok) throw new Error("Run entries capability failed");
        expect(ledger.data.data).toEqual(entries);
      }
      const who = { id: `user:${id}`, actor: authority.actor, accessSubject: authority.accessSubject, scopes: [] };
      expect((await codeLiveChannels.codeDetails.authorize(`code.details:${codeId}`, [who])).has(who.id)).toBe(id === owner);
      expect((await codeLiveChannels.codeRun.authorize(codeRunKey(codeId, runId), [who])).has(who.id)).toBe(id === owner);
      expect(await codeLiveChannels.codeRun.authorize(codeRunKey(codeId, "99999999-9999-4999-8999-999999999999"), [who])).toEqual(
        new Set(),
      );
    }
  });
  test("foreign and guest readers get NOT_FOUND, including a deleted Code", async () => {
    const guestId = "66666666-6666-4666-8666-666666666666";
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${guestId}::uuid,'output-guest','local','guest')`;
    const guest = await accounts.users.get({ id: guestId });
    if (!guest) throw new Error("Missing guest");
    for (const user of [guest, { ...guest, profile: "user" as const, roles: ["user" as const] }]) {
      const context = {
        authority: {
          actor: { kind: "user" as const, user },
          accessSubject: { type: "user" as const, userId: user.id },
          credentialKind: "session" as const,
          scopes: [],
        },
      };
      await expect(readCodeRunEntries({ codeId, runId }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(readCodeRunEntries({ codeId: "c_deleted", runId }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
  test("the owning resource manager gets output and an open connection is revoked on lost management", async () => {
    setSystemTime(fixed);
    const resourceCodeId = "c_resourceout";
    const resourceRunId = "88888888-8888-4888-8888-888888888888";
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,created_by)
      VALUES('code:example.item:output-place','code',${owner}::uuid) RETURNING id`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,service_account_id,title)
      VALUES(${resourceCodeId},'resource','example.item','output-place',${account!.id}::uuid,'Resource output')`;
    const [version] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,source_bytes,bundle_bytes,created_by)
      VALUES(${resourceCodeId},1,'{}'::jsonb,'fixture',${"a".repeat(64)},${"b".repeat(64)},2,7,${owner}::uuid) RETURNING id`;
    const output = emptyCodeOutput(1);
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit,state,console_output)
      VALUES(${resourceRunId}::uuid,${resourceCodeId},${version!.id}::uuid,'manual','run',32768,200,'running',${JSON.stringify(output)}::text::jsonb)`;
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Missing resource manager");
    const authority = {
      actor: { kind: "user" as const, user },
      accessSubject: { type: "user" as const, userId: user.id },
      credentialKind: "session" as const,
      scopes: [],
    };
    let manager = true;
    const ownerReader = spyOn(access, "readCodeOwner").mockImplementation(async () => ({ title: "Output place", admin: manager }));
    const topic = sync.topic<LiveEnvelope>(liveTopicConfig("core"));
    await sync.ready();
    const engine = createLiveEngine({ appId: "core", topic: () => topic, channels: codeLiveChannels });
    const frames: { t: string; code?: string }[] = [];
    const until = async (ready: () => boolean) => {
      const deadline = performance.now() + 5000;
      while (!ready()) {
        if (performance.now() > deadline) throw new Error("Live fixture timed out");
        await Bun.sleep(5);
      }
    };
    try {
      expect((await readCodeRunEntries({ codeId: resourceCodeId, runId: resourceRunId }, { authority })).output).toEqual(output);
      const viewer = { id: `user:${owner}`, actor: authority.actor, accessSubject: authority.accessSubject, scopes: [] };
      const socket = engine.open(
        { send: (frame) => frames.push(JSON.parse(frame)), close: () => {}, getBufferedAmount: () => 0 },
        viewer,
        async () => viewer,
      );
      socket.message(
        JSON.stringify({
          t: "sub",
          id: "resource",
          channel: "codeRun",
          scope: { codeId: resourceCodeId, runId: resourceRunId },
          after: await topic.head(),
        }),
      );
      await until(() => frames.some((frame) => frame.t === "ready"));
      manager = false;
      await topic.publish({ data: { v: 1, k: resourceCodeId, a: true }, orderingKey: resourceCodeId });
      await until(() => frames.some((frame) => frame.t === "revoked"));
      expect(frames.at(-1)).toMatchObject({ t: "revoked", code: "access_denied" });
      await expect(readCodeRunEntries({ codeId: resourceCodeId, runId: resourceRunId }, { authority })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await sql`DELETE FROM code.codes WHERE id=${resourceCodeId}`;
      await expect(readCodeRunEntries({ codeId: resourceCodeId, runId: resourceRunId }, { authority })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      engine.stop();
      ownerReader.mockRestore();
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
  test("a run channel fans out through NATS with 0 SQL per delivery and isolates other runs", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    const other = await attempt();
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Missing output owner");
    const viewer = {
      id: `user:${owner}`,
      actor: { kind: "user" as const, user },
      accessSubject: { type: "user" as const, userId: owner },
      scopes: [],
    };
    const topic = sync.topic<LiveEnvelope>(liveTopicConfig("core"));
    await sync.ready();
    const engine = createLiveEngine({ appId: "core", topic: () => topic, channels: codeLiveChannels });
    const frames: { t: string; data?: unknown }[] = [];
    const meter = await meterSql();
    const until = async (ready: () => boolean) => {
      const deadline = performance.now() + 5000;
      while (!ready()) {
        if (performance.now() > deadline) throw new Error("Live fixture timed out");
        await Bun.sleep(5);
      }
    };
    try {
      const admission = await meter.during(async () => {
        const socket = engine.open(
          { send: (frame) => frames.push(JSON.parse(frame)), close: () => {}, getBufferedAmount: () => 0 },
          viewer,
          async () => viewer,
        );
        socket.message(
          JSON.stringify({ t: "sub", id: "run", channel: "codeRun", scope: { codeId, runId: proof.runId }, after: await topic.head() }),
        );
        await until(() => frames.some((frame) => frame.t === "ready"));
      });
      expect(admission).toHaveLength(2);
      expect(
        await meter.during(async () => {
          await receiveCodeOutput(other, batch(1, "Other run"));
          await receiveCodeOutput(proof, batch(1, "Selected run"));
          await until(() => frames.some((frame) => frame.t === "event"));
          await connection.flush();
        }),
      ).toEqual([]);
      expect(frames.filter((frame) => frame.t === "event").map((frame) => frame.data)).toEqual([
        expect.objectContaining({ type: "code.output", runId: proof.runId }),
      ]);
      expect(codeLiveChannels.codeRun.accessKey(codeRunKey(codeId, proof.runId))).toBe(codeId);
      const [saved] = await sql<
        { payload: LiveEnvelope }[]
      >`SELECT payload FROM events.outbox WHERE ordering_key=${codeRunKey(codeId, proof.runId)} ORDER BY seq DESC LIMIT 1`;
      expect(saved?.payload.d).toMatchObject({ type: "code.run", runId: proof.runId, state: "running" });
    } finally {
      engine.stop();
      await meter.close();
    }
  });
  test("a running step restores missing reservations after a deploy before accepting more metadata", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    const at = new Date(fixed).toISOString();
    const step = { kind: "step" as const, id: 1, at, label: "Read", status: "running" as const, startedAt: at };
    await receiveCodeOutput(proof, { seq: 1, entries: [step], droppedLines: 0, droppedBytes: 0 });
    const cacheKey = `core:code-output:v1:${proof.runId}`;
    const state = JSON.parse((await redis.get(cacheKey))!);
    const fresh = state.stepReservations["1:step:1"];
    delete state.stepReservations;
    await redis.set(cacheKey, JSON.stringify(state));
    setSystemTime(fixed + 1000);
    await receiveCodeOutput(proof, {
      seq: 2,
      entries: [
        {
          ...step,
          status: "succeeded",
          endedAt: new Date().toISOString(),
          message: "x".repeat(CODE_OUTPUT_STEP_LIMITS.textReserveBytes - 2),
        },
      ],
      droppedLines: 0,
      droppedBytes: 0,
    });
    const saved = JSON.parse((await redis.get(cacheKey))!);
    expect(saved.stepReservations["1:step:1"]).toEqual(fresh);
    expect((await replayCodeOutput(proof.runId)).entries).toEqual([
      expect.objectContaining({
        status: "succeeded",
        label: [{ type: "text", text: "Read" }],
        message: [{ type: "text", text: "x".repeat(CODE_OUTPUT_STEP_LIMITS.textReserveBytes - 2) }],
      }),
    ]);
    expect((await replayCodeOutput(proof.runId)).droppedLines).toBe(0);
  });
  test("all short handles survive the shipped collector, supervisor and Core with a remembered secret", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    await rememberCodeOutputSecrets({ ...claims, ...proof }, [{ name: "TOKEN", value: "abcdefgh", sent: "Bearer abcdefgh" }]);
    const source = await Bun.file(new URL("../../../runner/src/assets/console.js", import.meta.url)).text();
    const { createCodeConsole } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const captureLimits = runnerOutputLimits({ ...proof, trustTier: "code", outputBytes: 32768 });
    const sent: CodeOutputBatch[] = [];
    const supervisor = new RunnerOutput(async (batch) => {
      sent.push(batch);
      await receiveCodeOutput(proof, batch);
    }, proof);
    const output = createCodeConsole(
      { call: async (_operation: string, input: unknown) => supervisor.write(CodeOutputBatchSchema.parse(input)) },
      captureLimits,
    );
    output.logger.info("abcdefgh!");
    const labels = Array.from({ length: CODE_OUTPUT_STEP_LIMITS.count }, (_, index) => `Upload ${index}!`);
    for (const label of labels) {
      const step = output.logger.step(label, { icon: "upload", description: "Transfer!" });
      step.start();
      step.succeed("Done!");
    }
    output.logger.info("ordinary output!");
    const meter = await meterSql();
    try {
      expect(await meter.during(() => output.finish())).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.droppedLines).toBe(0);
      const snapshot = await replayCodeOutput(proof.runId);
      expect(snapshot.droppedLines).toBe(0);
      expect(snapshot.entries.filter(isCodeOutputStepEntry).map((step) => step.label)).toEqual(
        labels.map((text) => [{ type: "text", text }]),
      );
      expect(snapshot.entries.filter(isCodeOutputLogEntry).flatMap((log) => log.text)).toEqual([
        { type: "secret", name: "TOKEN" },
        { type: "text", text: "!" },
        { type: "text", text: "ordinary output!" },
      ]);
      const state = JSON.parse((await redis.get(`core:code-output:v1:${proof.runId}`))!);
      for (const entry of sent[0]!.entries)
        if (entry.kind === "step") expect(state.stepReservations[`1:step:${entry.id}`]).toEqual({ bytes: codeOutputStepBytes(entry) });
      let live = emptyCodeOutput();
      for await (const event of codeOutputTopic().replay({ tenantId: proof.runId })) live = applyCodeOutputEvent(live, event.data);
      expect(live).toEqual(snapshot);
      expect(await meter.during(() => persistCodeOutput(proof.runId, sql, 1, "succeeded"))).toHaveLength(1);
      const [row] = await sql<{ console_output: unknown }[]>`SELECT console_output FROM code.runs WHERE id=${proof.runId}::uuid`;
      expect(row!.console_output).toEqual(snapshot);
    } finally {
      await meter.close();
    }
  });
  test("collector revisions keep completion text after logs through Core and replay", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    await rememberCodeOutputSecrets({ ...claims, ...proof }, [{ name: "TOKEN", value: "abcdefgh", sent: "Bearer abcdefgh" }]);
    const source = await Bun.file(new URL("../../../runner/src/assets/console.js", import.meta.url)).text();
    const { createCodeConsole } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const supervisor = new RunnerOutput((batch) => receiveCodeOutput(proof, batch), proof);
    const output = createCodeConsole(
      { call: async (_operation: string, batch: unknown) => supervisor.write(batch) },
      runnerOutputLimits({ ...proof, trustTier: "code", outputBytes: 32768 }),
    );
    const step = output.logger.step("Upload");
    step.start();
    output.logger.info("Bearer abcd");
    step.succeed("efgh");
    await output.finish();
    const snapshot = await replayCodeOutput(proof.runId);
    expect(snapshot.droppedLines).toBe(0);
    expect(snapshot.entries.filter(isCodeOutputStepEntry)).toMatchObject([
      { label: [{ type: "text", text: "Upload" }], status: "succeeded" },
    ]);
    expect(JSON.stringify(snapshot)).toContain('"type":"secret"');
    expect(JSON.stringify(snapshot)).not.toContain("efgh");
    expect(JSON.stringify(snapshot)).not.toContain("abcd");
    let live = emptyCodeOutput();
    for await (const event of codeOutputTopic().replay({ tenantId: proof.runId })) live = applyCodeOutputEvent(live, event.data);
    expect(live).toEqual(snapshot);
    await persistCodeOutput(proof.runId);
    expect(await replayCodeOutput(proof.runId)).toEqual(snapshot);
  });
  test("rejected handle revisions are tombstoned without suppressing later output", async () => {
    setSystemTime(fixed);
    const admittedCount = Math.floor(CODE_OUTPUT_STEP_LIMITS.count / 2);
    const proof = await attempt(CODE_OUTPUT_STEP_LIMITS.metadataBytes * admittedCount + 2);
    await rememberCodeOutputSecrets({ ...claims, ...proof }, [{ name: "TOKEN", value: "abcdefgh", sent: "Bearer abcdefgh" }]);
    const at = new Date(fixed).toISOString();
    const step = { kind: "step" as const, id: 1, at, label: "Read!", status: "pending" as const };
    await receiveCodeOutput(proof, {
      seq: 1,
      entries: Array.from({ length: admittedCount }, (_, index) => ({ ...step, id: index + 1 })),
      droppedLines: 0,
      droppedBytes: 0,
    });
    setSystemTime(fixed + 1000);
    const rejected = { ...step, id: admittedCount + 1 };
    await receiveCodeOutput(proof, { seq: 2, entries: [rejected], droppedLines: 0, droppedBytes: 0 });
    setSystemTime(fixed + 2000);
    await receiveCodeOutput(proof, batch(3, "ordinary text after gap!"));
    const before = await replayCodeOutput(proof.runId);
    setSystemTime(fixed + 3000);
    await receiveCodeOutput(proof, {
      seq: 4,
      entries: [{ ...rejected, status: "running", startedAt: at }, ...batch(4, "kept!").entries],
      droppedLines: 0,
      droppedBytes: 0,
    });
    const after = await replayCodeOutput(proof.runId);
    expect(after.droppedLines).toBe(before.droppedLines);
    expect(after.entries.filter(isCodeOutputLogEntry).at(-1)?.text).toEqual([{ type: "text", text: "kept!" }]);
    const state = JSON.parse((await redis.get(`core:code-output:v1:${proof.runId}`))!);
    expect(state.stepReservations[`1:step:${rejected.id}`]).toEqual({ bytes: 0, rejected: true });
    expect(Object.keys(state.stepReservations).length).toBeLessThanOrEqual(CODE_OUTPUT_STEP_LIMITS.count);
  });
  test("steps upsert in one window with zero SQL per update and one final write", async () => {
    const proof = await attempt();
    setSystemTime(fixed);
    const step = { kind: "step" as const, id: 1, at: new Date(fixed).toISOString(), label: "Read", status: "pending" as const };
    const meter = await meterSql();
    try {
      const submit = (seq: number, entry: Parameters<typeof receiveCodeOutput>[1]["entries"][number]) =>
        receiveCodeOutput(proof, { seq, entries: [entry], droppedLines: 0, droppedBytes: 0 });
      expect(await meter.during(() => submit(1, step))).toEqual([]);
      setSystemTime(fixed + 1000);
      expect(await meter.during(() => submit(2, { ...step, status: "running", startedAt: step.at }))).toEqual([]);
      setSystemTime(fixed + 2000);
      expect(
        await meter.during(() =>
          submit(3, { ...step, status: "succeeded", startedAt: step.at, endedAt: new Date().toISOString(), message: "Done" }),
        ),
      ).toEqual([]);
      const window = await replayCodeOutput(proof.runId);
      expect(window.entries).toEqual([
        {
          ...step,
          id: "1:step:1",
          label: [{ type: "text", text: "Read" }],
          status: "succeeded",
          startedAt: step.at,
          endedAt: new Date().toISOString(),
          message: [{ type: "text", text: "Done" }],
        },
      ]);
      let replay = emptyCodeOutput();
      for await (const event of codeOutputTopic().replay({ tenantId: proof.runId })) replay = applyCodeOutputEvent(replay, event.data);
      expect(replay).toEqual(window);
      expect(await meter.during(() => persistCodeOutput(proof.runId))).toHaveLength(1);
      const [row] = await sql<{ console_output: unknown }[]>`SELECT console_output FROM code.runs WHERE id=${proof.runId}::uuid`;
      expect(row!.console_output).toEqual(window);
      for (const id of [owner, reader]) {
        const user = await accounts.users.get({ id });
        if (!user) throw new Error("Missing step fixture user");
        const result = await readCodeRun(
          { codeId, runId: proof.runId },
          {
            authority: {
              actor: { kind: "user", user },
              accessSubject: { type: "user", userId: id },
              credentialKind: "session",
              scopes: [],
            },
          },
        );
        if (id === reader) expect(result.contents).toBeNull();
        else expect(result.contents?.consoleOutput).toEqual(window);
      }
    } finally {
      await meter.close();
    }
  });
  test("step revisions preserve accepted text in live, covering snapshot and replay", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    await rememberCodeOutputSecrets({ ...claims, runId: proof.runId }, [{ name: "TOKEN", value: "abcdefgh", sent: "Bearer abcdefgh" }]);
    const at = new Date(fixed).toISOString();
    const step = { kind: "step" as const, id: 1, at, label: "gh", status: "pending" as const };
    await receiveCodeOutput(proof, { ...batch(1, "abcdef"), entries: [...batch(1, "abcdef").entries, step] });
    setSystemTime(fixed + 1000);
    await receiveCodeOutput(proof, { seq: 2, entries: [{ ...step, status: "running", startedAt: at }], droppedLines: 0, droppedBytes: 0 });
    const snapshot = await replayCodeOutput(proof.runId);
    expect(JSON.stringify(snapshot)).toContain('"type":"secret"');
    expect(JSON.stringify(snapshot)).not.toContain('"text":"gh"');
    const raw = await redis.get(`core:code-output:v1:${proof.runId}`);
    expect(JSON.parse(raw!).window).toEqual(snapshot);
    let liveWindow = emptyCodeOutput();
    for await (const event of codeOutputTopic().replay({ tenantId: proof.runId })) {
      expect(JSON.stringify(event.data)).not.toContain('"text":"gh"');
      liveWindow = applyCodeOutputEvent(liveWindow, event.data);
    }
    expect(liveWindow).toEqual(snapshot);
    setSystemTime(fixed + 2000);
    await receiveCodeOutput(proof, {
      seq: 3,
      entries: [{ ...step, status: "succeeded", startedAt: at, endedAt: at, message: "Done" }],
      droppedLines: 1,
      droppedBytes: 1,
    });
    expect((await replayCodeOutput(proof.runId)).entries.find((entry) => entry.kind === "step")).toMatchObject({
      status: "succeeded",
      label: [],
    });
    const settled = await replayCodeOutput(proof.runId);
    setSystemTime(fixed + 3000);
    await receiveCodeOutput(proof, {
      seq: 4,
      entries: [{ ...step, label: "Changed", status: "failed", endedAt: at, message: "Changed" }],
      droppedLines: 0,
      droppedBytes: 0,
    });
    expect((await replayCodeOutput(proof.runId)).entries).toEqual(settled.entries);
  });
  for (const outcome of ["succeeded", "failed", "cancelled", "wall_clock_limit"]) {
    test(`closing ${outcome} settles running steps and retains pending plans`, async () => {
      setSystemTime(fixed);
      const proof = await attempt();
      const at = new Date(fixed).toISOString();
      const base = { kind: "step" as const, id: 1, at, label: "Read", status: "pending" as const };
      await receiveCodeOutput(proof, {
        seq: 1,
        entries: [base, { ...base, status: "running", startedAt: at }, { ...base, id: 2, label: "Save" }],
        droppedLines: 0,
        droppedBytes: 0,
      });
      const window = await closeCodeOutput(proof.runId, 1, outcome);
      expect(window.entries[0]).toMatchObject({ status: outcome === "succeeded" ? "succeeded" : "failed", endedAt: at });
      expect(window.entries[1]).toMatchObject({ status: "pending" });
      if (outcome !== "succeeded") expect(window.entries[0]).toMatchObject({ reason: "run_ended", message: [] });
      expect(await closeCodeOutput(proof.runId, 1, outcome)).toEqual(window);
      await persistCodeOutput(proof.runId, sql, 1, outcome);
      const [row] = await sql<{ console_output: unknown }[]>`SELECT console_output FROM code.runs WHERE id=${proof.runId}::uuid`;
      expect(row!.console_output).toEqual(window);
    });
  }
  test("author completion text stays distinct from the automatic reason field", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    const at = new Date(fixed).toISOString();
    await receiveCodeOutput(proof, {
      seq: 1,
      entries: [{ kind: "step", id: 1, at, label: "Read", status: "failed", endedAt: at, message: "code_run_ended" }],
      droppedLines: 0,
      droppedBytes: 0,
    });
    const window = await closeCodeOutput(proof.runId);
    expect(window.entries[0]).toMatchObject({ message: [{ type: "text", text: "code_run_ended" }] });
    expect(window.entries[0]).not.toHaveProperty("reason");
  });
  test("final settlement completes a pending step field in the same persisted row", async () => {
    setSystemTime(fixed);
    const proof = await attempt();
    await rememberCodeOutputSecrets({ ...claims, runId: proof.runId }, [{ name: "TOKEN", value: "abcdefgh", sent: "Bearer abcdefgh" }]);
    const step = {
      kind: "step" as const,
      id: 1,
      at: new Date(fixed).toISOString(),
      label: "Read",
      status: "failed" as const,
      endedAt: new Date(fixed).toISOString(),
      message: "abcd",
    };
    await receiveCodeOutput(proof, { seq: 1, entries: [step], droppedLines: 0, droppedBytes: 0 });
    expect((await replayCodeOutput(proof.runId)).entries).toHaveLength(1);
    await persistCodeOutput(proof.runId);
    const window = await replayCodeOutput(proof.runId);
    expect(window.entries).toEqual([
      { ...step, id: "1:step:1", label: [{ type: "text", text: "Read" }], message: [{ type: "secret", name: "TOKEN" }] },
    ]);
    const [row] = await sql<{ console_output: unknown }[]>`SELECT console_output FROM code.runs WHERE id=${proof.runId}::uuid`;
    expect(row!.console_output).toEqual(window);
  });
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
  for (const source of ["cadence", "batch", "sequence"] as const) {
    test(`harden deferred output continuity with ${source} loss`, async () => {
      setSystemTime(fixed);
      const proof = await attempt();
      const value = "abcdefgh";
      await rememberCodeOutputSecrets({ ...claims, ...proof }, [{ name: "TOKEN", value, sent: value }]);
      await receiveCodeOutput(proof, batch(1, "abcd"));
      if (source === "cadence") await receiveCodeOutput(proof, batch(2, "efgh"));
      setSystemTime(fixed + 1000);
      const next = batch(source === "batch" ? 2 : 3, "ordinary");
      if (source === "batch") {
        next.droppedLines = 1;
        next.droppedBytes = Buffer.byteLength("efgh");
      }
      await receiveCodeOutput(proof, next);
      const user = await accounts.users.get({ id: owner });
      if (!user) throw new Error("Missing output fixture user");
      const read = () =>
        readCodeRun(
          { codeId, runId: proof.runId },
          {
            authority: {
              actor: { kind: "user", user },
              accessSubject: { type: "user", userId: owner },
              scopes: [],
              credentialKind: "session",
            },
          },
        );
      const page = await read();
      expect(page.contents?.consoleOutput?.entries.filter(isCodeOutputLogEntry).flatMap((entry) => entry.text)).toEqual([
        { type: "secret", name: "TOKEN" },
      ]);
      expect(page.contents?.consoleOutput?.droppedLines).toBeGreaterThanOrEqual(1);
      const longest = Math.max(...[...secretEchoReplacements([{ name: "TOKEN", value, sent: value }]).keys()].map((text) => text.length));
      setSystemTime(fixed + 2000);
      await receiveCodeOutput(proof, batch(next.seq + 1, ".".repeat(longest)));
      setSystemTime(fixed + 3000);
      await receiveCodeOutput(proof, batch(next.seq + 2, "later"));
      const recovered = await read();
      expect(recovered.contents?.consoleOutput?.entries.filter(isCodeOutputLogEntry).flatMap((entry) => entry.text)).toEqual([
        { type: "secret", name: "TOKEN" },
        { type: "text", text: "later" },
      ]);
      expect(recovered.contents?.consoleOutput?.droppedLines).toBeGreaterThan(page.contents!.consoleOutput!.droppedLines);
    });
  }
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
