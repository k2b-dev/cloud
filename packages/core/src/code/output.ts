import { timingSafeEqual } from "node:crypto";
import { lazySync, redis, sql } from "@k2b/cloud";
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
  cleanCodeOutput,
  codeDetailsKey,
  codeOutputParts,
  emptyCodeOutput,
} from "@k2b/cloud/code";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { type RunnerLease, RunnerLeaseLostError, type RunnerLeaseProof } from "@k2b/cloud/code/runner";
import { defineLive, LIVE_LIMITS } from "@k2b/cloud/events";
import { purposeSecretCipher } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { z } from "zod";
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
  window: CodeOutputWindowSchema,
});
type State = z.infer<typeof StateSchema>;
const tokenDigest = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const ttlAt = (deadlineAt: number) => deadlineAt + CODE_OUTPUT_TOPIC_CONFIG.retention.maxAgeMs;
const CAS = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
  if tonumber(redis.call('GET',KEYS[2]) or '0')<=tonumber(ARGV[4]) then return -1 end
  redis.call('SET',KEYS[1],ARGV[2],'PXAT',ARGV[3]); return 1`;

/** Issued only after the durable lease commit. A delayed replica cannot replace a newer generation. */
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
    window: emptyCodeOutput(lease.generation),
  };
  await redis.send("EVAL", [
    `local old=redis.call('GET',KEYS[1])
    if old and cjson.decode(old).generation>=tonumber(ARGV[1]) then return 0 end
    redis.call('SET',KEYS[1],ARGV[2],'PXAT',ARGV[3]);
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
    `local old=redis.call('GET',KEYS[1]); if not old then return 0 end
    redis.call('SET',KEYS[1],math.max(tonumber(old),tonumber(ARGV[1])),'KEEPTTL'); return 1`,
    "1",
    leaseKey(claims.runId, claims.generation),
    String(leaseExpiresAt),
  ]);
}

/** Before sending a credential, retain its exact raw/prefixed/encoded replacement set, encrypted and lease-scoped.
 * A cache failure refuses that HTTP request: output must never bypass an unavailable redaction set.
 */
export async function rememberCodeOutputSecrets(
  claims: CodeRunTokenClaims,
  inserted: readonly { name: string; value: string; sent: string }[],
) {
  if (!inserted.length) return;
  const replacements = [...secretEchoReplacements(inserted)];
  const encrypted = purposeSecretCipher(secretPurpose).encrypt(JSON.stringify(replacements), secretContext(claims));
  const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(replacements)).digest("hex");
  await redis.send("EVAL", [
    `redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('PEXPIREAT',KEYS[1],ARGV[3]); return 1`,
    "1",
    secretKey(claims.runId, claims.generation),
    digest,
    encrypted,
    String(ttlAt(claims.exp * 1000)),
  ]);
}
async function replacementsFor(claims: Pick<CodeRunTokenClaims, "runId" | "generation">) {
  const encrypted = z.array(z.string()).parse(await redis.send("HVALS", [secretKey(claims.runId, claims.generation)]));
  const replacements = new Map<string, string>();
  for (const item of encrypted) {
    const entries = z
      .array(z.tuple([z.string(), z.string()]))
      .parse(JSON.parse(purposeSecretCipher(secretPurpose).decrypt(item, secretContext(claims))));
    for (const [value, marker] of entries) replacements.set(value, marker);
  }
  return replacements;
}
/** Literal longest-first replacement, using exactly the HTTP echo spellings. Clean before and after replacement. */
export function sanitizeCodeOutput(batch: CodeOutputBatch, replacements: ReadonlyMap<string, string>) {
  const alternatives = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = alternatives.length ? new RegExp(alternatives.join("|"), "g") : null;
  return batch.lines.flatMap(({ level, text }) =>
    text.split(/\r\n|\n|\r/).map((text) => {
      const clean = cleanCodeOutput(text);
      const redacted = pattern ? clean.replace(pattern, (value) => replacements.get(value)!) : clean;
      return { level, parts: codeOutputParts(cleanCodeOutput(redacted)) };
    }),
  );
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
  const lines = sanitizeCodeOutput(batch, await replacementsFor(claims));
  if (batch.seq <= state.inputSeq) return;
  const limited = state.lastAt > 0 && now - state.lastAt < CODE_OUTPUT_INTERVAL_MS;
  const dropped = {
    lines: batch.droppedLines + (limited ? lines.length : 0),
    bytes: batch.droppedBytes + (limited ? Buffer.byteLength(JSON.stringify(lines)) : 0),
  };
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
  const frame = appendCodeOutput(emptyCodeOutput(state.generation), limited ? [] : lines, LIVE_LIMITS.frameBytes - envelopeBytes, dropped);
  const nextWindow = appendCodeOutput({ ...state.window, seq: state.window.seq + 1 }, frame.lines, state.budget, {
    lines: frame.droppedLines,
    bytes: frame.droppedBytes,
  });
  const event: CodeOutputEvent = { ...nextWindow, lines: frame.lines, type: "code.output", runId: claims.runId, budget: state.budget };
  const next = { ...state, inputSeq: batch.seq, lastAt: limited ? state.lastAt : now, window: nextWindow };
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
  if (limited) return;
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
  const snapshot = raw ? StateSchema.parse(JSON.parse(raw)).window : emptyCodeOutput();
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
/** One guarded write at the run's terminal transition, including recovery. The run owns deletion and 30-day retention. */
export async function persistCodeOutput(runId: string, db: SQL = sql) {
  // Freeze admission before reading the window. A racing CAS must observe the missing lease and refuse.
  const raw = await redis.send("EVAL", [
    `local raw=redis.call('GET',KEYS[1]); if not raw then return nil end
    local s=cjson.decode(raw); redis.call('DEL',KEYS[1]..':lease:'..s.generation); return raw`,
    "1",
    key(runId),
  ]);
  if (raw !== null && typeof raw !== "string") throw new Error("code_output_unavailable");
  const window = raw ? StateSchema.parse(JSON.parse(raw)).window : emptyCodeOutput();
  await db`UPDATE code.runs SET console_output=${JSON.stringify(window)}::text::jsonb WHERE id=${runId}::uuid AND console_output IS NULL`;
}
