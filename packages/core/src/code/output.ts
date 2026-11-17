import { timingSafeEqual } from "node:crypto";
import { lazySync, redis, sql } from "@k2b/cloud";
import { CodeBridgeRefusal } from "@k2b/cloud/api";
import {
  appendCodeOutput,
  applyCodeOutputEvent,
  CODE_OUTPUT_INTERVAL_MS,
  type CodeOutputBatch,
  CodeOutputBatchSchema,
  type CodeOutputEvent,
  CodeOutputEventSchema,
  type CodeOutputWindow,
  CodeOutputWindowSchema,
  codeDetailsKey,
  emptyCodeOutput,
} from "@k2b/cloud/code";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { type RunnerLease, RunnerLeaseLostError, type RunnerLeaseProof } from "@k2b/cloud/code/runner";
import { defineLive, LIVE_LIMITS } from "@k2b/cloud/events";
import { purposeSecretCipher } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { z } from "zod";
import { compileOutputRedaction, type OutputRedactor, redactOutput } from "./output-redaction";
import { secretEchoReplacements } from "./secret-echo";

/** Same bounded broker budget as the AI stream; one shared topic, partitioned by run, never one stream per run. */
export const CODE_OUTPUT_TOPIC_CONFIG = {
  id: "core-code-output-v1",
  owner: "core",
  retention: { maxAgeMs: 15 * 60 * 1000, maxBytes: 256 * 1024 * 1024 },
  // Core bounds event data with LIVE_LIMITS.frameBytes below. Keep Sync's
  // default payload budget for its additional transport envelope as well.
};
export const codeOutputTopic = lazySync((sync) => sync.topic<CodeOutputEvent>(CODE_OUTPUT_TOPIC_CONFIG));
const live = defineLive({ appId: "core", event: CodeOutputEventSchema });
const key = (runId: string) => `core:code-output:v1:${runId}`;
const secretKey = (runId: string, generation: number) => `${key(runId)}:secrets:${generation}`;
const dropsKey = (runId: string, generation: number) => `${key(runId)}:drops:${generation}`;
const leaseKey = (runId: string, generation: number) => `${key(runId)}:lease:${generation}`;
const secretPurpose = "cloud.code.output-redactions.v1";
const secretContext = (claims: Pick<CodeRunTokenClaims, "runId" | "generation">) => JSON.stringify([claims.runId, claims.generation]);
const StateSchema = z.object({
  codeId: z.string(),
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.number(),
  deadlineAt: z.number(),
  budget: z.number(),
  lastAt: z.number(),
  inputSeq: z.number(),
  pending: z.string().nullable(),
  redactionRevision: z.number(),
  countedDropLines: z.number(),
  countedDropBytes: z.number(),
  window: CodeOutputWindowSchema,
});
type State = z.infer<typeof StateSchema>;
const tokenDigest = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const ttlAt = (deadlineAt: number) => deadlineAt + CODE_OUTPUT_TOPIC_CONFIG.retention.maxAgeMs;
const CAS = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
  if tonumber(redis.call('GET',KEYS[2]) or '0')<=tonumber(ARGV[4]) then return -1 end
  redis.call('SET',KEYS[1],ARGV[2],'PXAT',ARGV[3]); return 1`;

/** Issued only after the durable lease commit. A delayed replica cannot replace a newer generation.
 * A new attempt resets the window, not the run-wide transport cadence.
 */
export async function openCodeOutput(
  lease: Pick<RunnerLease, "runId" | "codeId" | "generation" | "deadlineAt" | "leaseExpiresAt" | "token">,
  budget: number,
) {
  const state: State = {
    codeId: lease.codeId,
    tokenDigest: tokenDigest(lease.token),
    generation: lease.generation,
    deadlineAt: lease.deadlineAt,
    budget,
    lastAt: 0,
    inputSeq: 0,
    pending: null,
    redactionRevision: 0,
    countedDropLines: 0,
    countedDropBytes: 0,
    window: emptyCodeOutput(lease.generation),
  };
  await redis.send("EVAL", [
    // Replace only our encoded timestamp: re-encoding the state with Lua cjson
    // would turn its empty line array into an object.
    `if redis.call('GET',KEYS[2])=='0' then return 0 end
    local old=redis.call('GET',KEYS[1]); local next=ARGV[2]
    if old then
      local previous=cjson.decode(old)
      if previous.generation>=tonumber(ARGV[1]) then return 0 end
      next=string.gsub(next,'"lastAt":0','"lastAt":'..string.format('%.0f',previous.lastAt),1)
    end
    redis.call('SET',KEYS[1],next,'PXAT',ARGV[3]);
    redis.call('SET',KEYS[2],ARGV[4],'PXAT',ARGV[3]); return 1`,
    "2",
    key(lease.runId),
    leaseKey(lease.runId, lease.generation),
    String(lease.generation),
    JSON.stringify(state),
    String(ttlAt(lease.deadlineAt)),
    String(lease.leaseExpiresAt),
  ]);
}
/** Heartbeats change the lease field without replacing output a simultaneous batch has accepted. */
export async function renewCodeOutput(claims: CodeRunTokenClaims, leaseExpiresAt: number) {
  await redis.send("EVAL", [
    `local old=redis.call('GET',KEYS[1]); if not old or tonumber(old)<=tonumber(ARGV[2]) then return 0 end
    redis.call('SET',KEYS[1],math.max(tonumber(old),tonumber(ARGV[1])),'KEEPTTL'); return 1`,
    "1",
    leaseKey(claims.runId, claims.generation),
    String(leaseExpiresAt),
    String(Date.now()),
  ]);
}

type Compiled = { revision: string; redactor: OutputRedactor; expiresAt: number };
const compiled = new Map<string, Compiled>();
/** Individual encrypted replacements share the admitted payload byte budget. No eviction:
 * a dispatch requiring a replacement that cannot fit is visibly refused before issuance.
 */
export async function rememberCodeOutputSecrets(
  claims: CodeRunTokenClaims,
  inserted: readonly { name: string; value: string; sent: string }[],
) {
  if (!inserted.length) return;
  const raw = await redis.get(key(claims.runId));
  if (!raw) throw new RunnerLeaseLostError();
  const state = StateSchema.parse(JSON.parse(raw));
  if (state.generation !== claims.generation) throw new RunnerLeaseLostError();
  const entries = [...secretEchoReplacements(inserted)].flatMap((entry) => {
    const field = new Bun.CryptoHasher("sha256").update(JSON.stringify(entry)).digest("hex");
    const value = purposeSecretCipher(secretPurpose).encrypt(JSON.stringify(entry), secretContext(claims));
    return [field, value];
  });
  const admitted = await redis.send("EVAL", [
    `local raw=redis.call('GET',KEYS[2]); if not raw then return -1 end
    local s=cjson.decode(raw)
    if s.generation~=tonumber(ARGV[3]) or tonumber(redis.call('GET',KEYS[3]) or '0')<=tonumber(ARGV[4]) then return -1 end
    if tonumber(redis.call('HGET',KEYS[1],'revision') or '0')<s.redactionRevision then return -2 end
    local total=tonumber(redis.call('HGET',KEYS[1],'bytes') or '0'); local added=0
    for i=5,#ARGV,2 do
      if redis.call('HEXISTS',KEYS[1],ARGV[i])==0 then added=added+#ARGV[i]+#ARGV[i+1] end
    end
    if total+added>tonumber(ARGV[1]) then return 0 end
    if added>0 then
      for i=5,#ARGV,2 do redis.call('HSETNX',KEYS[1],ARGV[i],ARGV[i+1]) end
      redis.call('HSET',KEYS[1],'bytes',total+added)
      local revision=redis.call('HINCRBY',KEYS[1],'revision',1)
      local next=string.gsub(raw,'"redactionRevision":%d+','"redactionRevision":'..revision,1)
      redis.call('SET',KEYS[2],next,'KEEPTTL')
    end
    redis.call('PEXPIREAT',KEYS[1],ARGV[2]); return 1`,
    "3",
    secretKey(claims.runId, claims.generation),
    key(claims.runId),
    leaseKey(claims.runId, claims.generation),
    String(Math.max(0, state.budget - Buffer.byteLength("bytesrevision") - 2 * String(Number.MAX_SAFE_INTEGER).length)),
    String(ttlAt(state.deadlineAt)),
    String(claims.generation),
    String(Date.now()),
    ...entries,
  ]);
  if (admitted === -1) throw new RunnerLeaseLostError();
  if (admitted === -2) throw new CodeBridgeRefusal("code_http_output_redaction_unavailable");
  if (admitted !== 1) throw new CodeBridgeRefusal("code_http_output_redaction_limit");
}
async function redactorFor(claims: Pick<CodeRunTokenClaims, "runId" | "generation">, deadlineAt: number, expectedRevision: number) {
  const cacheKey = secretKey(claims.runId, claims.generation);
  const now = Date.now();
  for (const [key, value] of compiled) if (value.expiresAt <= now) compiled.delete(key);
  const revision = (await redis.send("HGET", [cacheKey, "revision"])) ?? "0";
  if (Number(revision) < expectedRevision) throw new Error("code_output_redaction_unavailable");
  const cached = compiled.get(cacheKey);
  if (cached && cached.revision === revision) return cached.redactor;
  const fields = z.record(z.string(), z.string()).parse(await redis.send("HGETALL", [cacheKey]));
  const replacements = new Map<string, string>();
  let actualRevision = "0";
  for (const [field, value] of Object.entries(fields)) {
    if (field === "revision") actualRevision = value;
    else if (field !== "bytes") {
      const entry = z
        .tuple([z.string(), z.string()])
        .parse(JSON.parse(purposeSecretCipher(secretPurpose).decrypt(value, secretContext(claims))));
      replacements.set(...entry);
    }
  }
  if (Number(actualRevision) < expectedRevision) throw new Error("code_output_redaction_unavailable");
  const redactor = compileOutputRedaction(replacements);
  compiled.set(cacheKey, { revision: actualRevision, redactor, expiresAt: ttlAt(deadlineAt) });
  return redactor;
}
export function sanitizeCodeOutput(batch: CodeOutputBatch, replacements: ReadonlyMap<string, string>) {
  return redactOutput(batch.lines, compileOutputRedaction(replacements), null, true).lines;
}
const PendingSchema = z.object({
  level: CodeOutputBatchSchema.shape.lines.element.shape.level,
  text: z.string(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
});
const sum = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
async function uncountedDrops(runId: string, state: State) {
  const values = z
    .array(z.string().nullable())
    .parse(await redis.send("HMGET", [dropsKey(runId, state.generation), "lines", "bytes", "seq"]));
  return { lines: Number(values[0] ?? 0), bytes: Number(values[1] ?? 0), seq: Number(values[2] ?? 0) };
}
function withDrops(state: State, dropped: { lines: number; bytes: number }): CodeOutputWindow {
  return {
    ...state.window,
    droppedLines: sum(state.window.droppedLines, Math.max(0, dropped.lines - state.countedDropLines)),
    droppedBytes: sum(state.window.droppedBytes, Math.max(0, dropped.bytes - state.countedDropBytes)),
  };
}
/** No SQL on the output hot path, including cold identity/settings caches. Pin the
 * exact Core-issued token at admission; only its digest lives in this output cache.
 * This supervisor-only proof grants output, never execution or reads. Heartbeats
 * still require the app proof and durable lease check. No JWT/JWKS/settings read
 * belongs here. CAS fences racing replicas, generations and terminal settlement.
 */
export async function receiveCodeOutput(proof: RunnerLeaseProof, raw: CodeOutputBatch) {
  const batch = CodeOutputBatchSchema.parse(raw);
  const previous = await redis.get(key(proof.runId));
  if (!previous) throw new RunnerLeaseLostError();
  const state = StateSchema.parse(JSON.parse(previous));
  const expires = Number(await redis.get(leaseKey(proof.runId, proof.generation)));
  const now = Date.now();
  if (
    state.generation !== proof.generation ||
    !timingSafeEqual(Buffer.from(state.tokenDigest, "hex"), Buffer.from(tokenDigest(proof.token), "hex")) ||
    !expires ||
    // signCodeRunToken floors the immutable deadline to whole seconds for exp.
    Math.min(expires, Math.floor(state.deadlineAt / 1000) * 1000) <= now
  )
    throw new RunnerLeaseLostError();
  const claims = { runId: proof.runId, generation: proof.generation, codeId: state.codeId };
  if (batch.seq <= state.inputSeq) return;
  const limited = state.lastAt > 0 && now - state.lastAt < CODE_OUTPUT_INTERVAL_MS;
  if (limited) {
    // Above cadence, touch only bounded counters, not the retained window or redaction state.
    const result = await redis.send("EVAL", [
      `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      if tonumber(redis.call('GET',KEYS[2]) or '0')<=tonumber(ARGV[2]) then return -1 end
      if tonumber(redis.call('HGET',KEYS[3],'seq') or '0')>=tonumber(ARGV[3]) then return 1 end
      for i,name in ipairs({'lines','bytes'}) do
        local old=tonumber(redis.call('HGET',KEYS[3],name) or '0')
        redis.call('HSET',KEYS[3],name,math.min(tonumber(ARGV[7]),old+tonumber(ARGV[i+3])))
      end
      redis.call('HSET',KEYS[3],'seq',ARGV[3]); redis.call('PEXPIREAT',KEYS[3],ARGV[6]); return 1`,
      "3",
      key(proof.runId),
      leaseKey(proof.runId, proof.generation),
      dropsKey(proof.runId, proof.generation),
      previous,
      String(now),
      String(batch.seq),
      String(
        sum(
          batch.droppedLines,
          batch.lines.reduce((total, line) => sum(total, line.text.split(/\r\n|\n|\r/).length), 0),
        ),
      ),
      String(sum(batch.droppedBytes, Buffer.byteLength(JSON.stringify(batch.lines)))),
      String(ttlAt(state.deadlineAt)),
      String(Number.MAX_SAFE_INTEGER),
    ]);
    if (result === -1) throw new RunnerLeaseLostError();
    if (result !== 1) throw new Error("code_output_busy");
    return;
  }
  const counts = await uncountedDrops(proof.runId, state);
  if (batch.seq <= counts.seq) return;
  const pending = state.pending
    ? PendingSchema.parse(JSON.parse(purposeSecretCipher(secretPurpose).decrypt(state.pending, secretContext(claims))))
    : null;
  const redacted = redactOutput(batch.lines, await redactorFor(claims, state.deadlineAt, state.redactionRevision), pending);
  const lines = redacted.lines;
  const dropped = { lines: batch.droppedLines, bytes: batch.droppedBytes };
  // Reserve the maximum encoded counter/sequence widths, derived from the safe-integer wire schema.
  // Trim in linear time before windowing: one raw text can contain many newline-separated lines.
  const envelopeBytes =
    Buffer.byteLength(
      JSON.stringify({
        ...emptyCodeOutput(state.generation),
        seq: Number.MAX_SAFE_INTEGER,
        droppedLines: Number.MAX_SAFE_INTEGER,
        droppedBytes: Number.MAX_SAFE_INTEGER,
        type: "code.output",
        runId: claims.runId,
        budget: state.budget,
      }),
    ) - Buffer.byteLength(JSON.stringify([]));
  const frame = appendCodeOutput(emptyCodeOutput(state.generation), lines, LIVE_LIMITS.frameBytes - envelopeBytes, dropped);
  const nextWindow = appendCodeOutput({ ...withDrops(state, counts), seq: state.window.seq + 1 }, frame.lines, state.budget, {
    lines: frame.droppedLines,
    bytes: frame.droppedBytes,
  });
  const event: CodeOutputEvent = { ...nextWindow, lines: frame.lines, type: "code.output", runId: claims.runId, budget: state.budget };
  const next: State = {
    ...state,
    inputSeq: batch.seq,
    lastAt: now,
    window: nextWindow,
    pending: redacted.pending ? purposeSecretCipher(secretPurpose).encrypt(JSON.stringify(redacted.pending), secretContext(claims)) : null,
    countedDropLines: counts.lines,
    countedDropBytes: counts.bytes,
  };
  const committed = await redis.send("EVAL", [
    CAS,
    "2",
    key(claims.runId),
    leaseKey(claims.runId, claims.generation),
    previous,
    JSON.stringify(next),
    String(ttlAt(state.deadlineAt)),
    String(Date.now()),
  ]);
  if (committed === -1) throw new RunnerLeaseLostError();
  if (committed !== 1) throw new Error("code_output_busy");
  try {
    await codeOutputTopic().publish({
      tenantId: claims.runId,
      orderingKey: claims.runId,
      data: event,
      idempotencyKey: `${claims.runId}:${claims.generation}:${event.seq}`,
    });
    await live.publishTransient({
      key: codeDetailsKey(claims.codeId),
      data: event,
      idempotencyKey: `output:${claims.runId}:${claims.generation}:${event.seq}`,
    });
  } catch {
    // The accepted snapshot survives. Missing live deltas recover from that snapshot on gap/reconnect or terminal state.
    // A logging DB insert here would break the zero-SQL failure path.
    console.warn("code_output_live_unavailable", { runId: claims.runId });
  }
  return;
}

/** Replay the run's topic deltas. The shared covering snapshot repairs gaps or broker retention/eviction. */
export async function replayCodeOutput(runId: string): Promise<CodeOutputWindow> {
  const raw = await redis.get(key(runId));
  const state = raw ? StateSchema.parse(JSON.parse(raw)) : null;
  const snapshot = state ? withDrops(state, await uncountedDrops(runId, state)) : emptyCodeOutput();
  let window = emptyCodeOutput();
  try {
    for await (const event of codeOutputTopic().replay({ tenantId: runId })) {
      window = applyCodeOutputEvent(window, CodeOutputEventSchema.parse(event.data));
      if (window.generation === snapshot.generation && window.seq >= snapshot.seq) break;
    }
  } catch (error) {
    if (!raw) throw error;
    // The shared snapshot covers accepted output even while the broker is unavailable.
    console.warn("code_output_replay_unavailable", { runId });
    return snapshot;
  }
  return !raw || JSON.stringify(window) === JSON.stringify(snapshot) ? window : snapshot;
}
/** Freeze each attempt before its durable end, including retries. A tombstone also
 * fences delayed admission of that generation; heartbeats never revive a closed lease.
 */
export async function closeCodeOutput(runId: string, generation?: number): Promise<CodeOutputWindow> {
  const raw = await redis.send("EVAL", [
    `local raw=redis.call('GET',KEYS[1]); local generation=tonumber(ARGV[1])
    if raw then local s=cjson.decode(raw); generation=generation or s.generation end
    if generation then redis.call('SET',KEYS[1]..':lease:'..generation,'0','PX',ARGV[2]) end
    return raw`,
    "1",
    key(runId),
    generation === undefined ? "" : String(generation),
    String(CODE_OUTPUT_TOPIC_CONFIG.retention.maxAgeMs),
  ]);
  if (raw !== null && typeof raw !== "string") throw new Error("code_output_unavailable");
  if (!raw) return emptyCodeOutput();
  const state = StateSchema.parse(JSON.parse(raw));
  if (generation !== undefined && state.generation !== generation) return state.window;
  const claims = { runId, generation: state.generation };
  const counts = await uncountedDrops(runId, state);
  let window = withDrops(state, counts);
  if (state.pending) {
    const pending = PendingSchema.parse(JSON.parse(purposeSecretCipher(secretPurpose).decrypt(state.pending, secretContext(claims))));
    window = appendCodeOutput(
      { ...window, seq: window.seq + 1 },
      [{ level: pending.level, parts: [{ type: "secret", name: pending.name }] }],
      state.budget,
    );
  }
  const next: State = { ...state, pending: null, window, countedDropLines: counts.lines, countedDropBytes: counts.bytes };
  await redis.send("EVAL", [
    `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
    redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL'); return 1`,
    "1",
    key(runId),
    raw,
    JSON.stringify(next),
  ]);
  compiled.delete(secretKey(runId, state.generation));
  return window;
}
/** One guarded write at the retained run's terminal transition, including recovery. */
export async function persistCodeOutput(runId: string, db: SQL = sql, generation?: number) {
  const window = await closeCodeOutput(runId, generation);
  await db`UPDATE code.runs SET console_output=${JSON.stringify(window)}::text::jsonb WHERE id=${runId}::uuid AND console_output IS NULL`;
}
