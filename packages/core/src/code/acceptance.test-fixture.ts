/// <reference path="../../../runner/src/workerd.d.ts" />
import { expect } from "bun:test";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sql } from "@k2b/cloud";
import type { CapabilityDispatchDependencies } from "@k2b/cloud/api";
import type { AppKey } from "@k2b/cloud/app-key";
import { signAppProof } from "@k2b/cloud/app-proof";
import { type CodeCheckHost, checkCode } from "@k2b/cloud/code";
import { type signCodeRunToken, verifyCodeRunToken } from "@k2b/cloud/code/run-token";
import { RUNNER_PATHS, type RunnerBridge, RunnerCallResponseSchema, type RunnerLease } from "@k2b/cloud/code/runner";
import {
  type CapabilityExecutionContext,
  CapabilityInvocationBodySchema,
  type CloudResourceRef,
  NormalizedCapabilityCallSchema,
} from "@k2b/cloud/contracts";
import { userFromActor } from "@k2b/cloud/server";
import type { requestPublicHttps } from "@k2b/cloud/services";
import { resolveInvocationAuthority } from "@k2b/cloud/services/identity/invocation-actor";
import { verifyInvocationToken } from "@k2b/cloud/services/identity/invocation-token";
import { issueInvocationToken } from "@k2b/cloud/services/identity/issue-invocation";
import type { Queue } from "@k2b/sync";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { AcceptanceProvider } from "../../../../scripts/fixtures/code-acceptance-provider";
import type { RunnerEngine, SandboxCall } from "../../../runner/src/engine";
import { Runner } from "../../../runner/src/runner";
import { createCodeBridgeRoutes, requireCodeRunFence } from "./bridge";
import { completeCodeRun, heartbeatCodeRun } from "./scheduling";
import { type CodeRunWakeup, fetchCodeRuns, readCodeRunnerConfig } from "./scheduling-runtime";
import { dispatchCodeSecretHttp } from "./secret-http";
import { codeBundleHash } from "./store";

/** Only repository-owned fictional source reaches this engine. C14 tests the real workerd isolation.
 * Each attempt imports a fresh checked bundle; the production Runner still owns cache, polling,
 * heartbeat, completion and drain. No injected callback substitutes for the author's source.
 */
class FixtureEngine implements RunnerEngine {
  readonly loaded = new Map<string, { source: string; call: SandboxCall }>();
  readonly executed: string[] = [];
  constructor(readonly enter: (signal: AbortSignal) => Promise<void>) {}
  async load(lease: RunnerLease, source: string, _config: unknown, call: SandboxCall, signal: AbortSignal) {
    signal.throwIfAborted();
    expect(codeBundleHash(source)).toBe(lease.bundleHash);
    this.loaded.set(lease.runId, { source, call });
  }
  async run(lease: RunnerLease, signal: AbortSignal) {
    const loaded = this.loaded.get(lease.runId);
    if (!loaded) throw new Error("Missing acceptance bundle");
    signal.throwIfAborted();
    await this.enter(signal);
    const module: unknown = await import(`data:text/javascript;base64,${Buffer.from(loaded.source).toString("base64")}#${lease.runId}`);
    const entrypoint = z.record(z.string(), z.unknown()).parse(module)[lease.entrypoint];
    if (typeof entrypoint !== "function") throw new Error("Missing acceptance entrypoint");
    this.executed.push(lease.runId);
    try {
      await entrypoint(lease.input, { call: loaded.call });
      return "succeeded" as const;
    } finally {
      this.loaded.delete(lease.runId);
    }
  }
  async kill(runId: string) {
    this.loaded.delete(runId);
  }
  async close() {
    this.loaded.clear();
  }
}

/** Real parser, tsgo and bundler in the C16 seccomp launcher; no checker result is fabricated. */
export async function acceptanceChecker() {
  const directory = await mkdtemp(join(tmpdir(), "cloud-c25-checker-"));
  const isolate = join(directory, "checker-isolate");
  const child = Bun.spawn(
    ["cc", "-O2", "-Wall", "-Wextra", "-Werror", resolve(import.meta.dir, "../../../runner/native/checker-isolate.c"), "-o", isolate],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const host: CodeCheckHost = {
    isolate,
    compiler: join(
      dirname(
        Bun.resolveSync(
          `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
          dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
        ),
      ),
      "lib/tsc",
    ),
    worker: resolve(import.meta.dir, "../../../cloud/scripts/code-check-worker.ts"),
    bun: process.execPath,
  };
  return {
    check: (request: Parameters<typeof checkCode>[0], signal?: AbortSignal) => checkCode(request, host, signal),
    async close() {
      await unlink(isolate);
      await rmdir(directory);
    },
  };
}

type Signer = { kid: string; key: CryptoKey; signUntil: Date };
/** Replace only HTTP delivery. Real invocation signatures, current mandate authority, normalized
 * bodies, provider validation, reviews, idempotency claims and owning domain services remain intact.
 */
export function acceptanceDispatch(providers: Map<string, AcceptanceProvider>, issuer: string, signer: Signer, key: JWTVerifyGetKey) {
  const fetch: NonNullable<CapabilityDispatchDependencies["fetch"]> = async (url, init) => {
    const path = new URL(String(url)).pathname.split("/");
    const review = path.at(-1) === "review";
    const localId = decodeURIComponent(path.at(review ? -2 : -1)!);
    const kind = path.includes("queries") ? "query" : "action";
    const appId = new URL(String(url)).hostname.split(".")[0]!;
    const compiled = providers.get(appId);
    if (!compiled) throw new Error("Unknown acceptance provider");
    const headers = new Headers(init?.headers);
    const schemaHash = headers.get("x-cloud-capability-schema-hash");
    const operation = `capability.${kind === "query" ? "query" : review ? "action.review" : "action.run"}:${localId}`;
    const verified = await verifyInvocationToken(
      headers.get("authorization")!.slice(7),
      { targetAppId: appId, operation, schemaHash: schemaHash! },
      { issuer, key },
    );
    const authority = verified && (await resolveInvocationAuthority(verified, sql, []));
    if (!authority) return Response.json({ code: "FORBIDDEN", message: "Invocation refused" }, { status: 403 });
    const context: CapabilityExecutionContext = {
      authority,
      actor: authority.actor,
      accessSubject: authority.accessSubject,
      user: userFromActor(authority.actor),
      origin: "app",
      locale: "de",
      requestId: headers.get("x-request-id")!,
      signal: init?.signal ?? new AbortController().signal,
      ...(!review && headers.has("idempotency-key") ? { idempotencyKey: headers.get("idempotency-key")! } : {}),
    };
    const body = CapabilityInvocationBodySchema.parse(JSON.parse(String(init?.body)));
    return compiled.invoke({ localId, ...body, expectedSchemaHash: schemaHash, context, kind, review });
  };
  return {
    fetch,
    withActiveSigner: async (_purpose, use) => sql.begin((db) => use({ ...signer, issuer, groupsAdmin: [] }, db)),
    signInvocation: (params, options) => issueInvocationToken(params, { ...options, groupsAdmin: [] }),
  } satisfies CapabilityDispatchDependencies;
}

/** Two real production supervisors, each with a private cache and engine, share Core's actual queue. */
export async function acceptanceRunners(input: {
  queue: Queue<CodeRunWakeup>;
  sign: typeof signCodeRunToken;
  issuer: string;
  key: JWTVerifyGetKey;
  runnerKey: AppKey;
  dispatch: CapabilityDispatchDependencies;
  httpSend?: typeof requestPublicHttps;
}) {
  const logs: string[] = [],
    responses: unknown[] = [];
  const foreignRuns = new Map<string, CloudResourceRef>();
  let arrivals = 0;
  let release: (() => void) | undefined;
  let pair: Promise<void> | undefined;
  const enter = async (signal: AbortSignal) => {
    if (!pair) return;
    const waiting = pair;
    if (++arrivals === 2) {
      pair = undefined;
      release?.();
    }
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        waiting,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
  const route = createCodeBridgeRoutes({
    dispatch: input.dispatch,
    token: { issuer: input.issuer, key: input.key },
    ownOrigins: async () => [input.issuer],
    ...(input.httpSend ? { http: (request) => dispatchCodeSecretHttp(request, input.httpSend) } : {}),
  });
  const claims = async (proof: { token: string }) => {
    const result = await verifyCodeRunToken(proof.token, { issuer: input.issuer, key: input.key });
    if (!result) throw new Error("Invalid acceptance lease");
    return result;
  };
  const bridge: RunnerBridge = {
    configure: () => readCodeRunnerConfig(),
    fetch: (request, signal) => fetchCodeRuns(request, signal, { queue: input.queue, sign: input.sign }),
    bundle: async (proof) =>
      sql.begin(async (db) => {
        const token = await claims(proof);
        await requireCodeRunFence(token, db);
        const [row] = await db<
          { bundle: string }[]
        >`SELECT bundle FROM code.versions WHERE id=${token.versionId}::uuid AND bundle_hash=${proof.bundleHash}`;
        if (!row) throw new Error("Missing acceptance bundle");
        return row.bundle;
      }),
    heartbeat: async (proof) => heartbeatCodeRun(await claims(proof)),
    complete: async (proof) => {
      await completeCodeRun(await claims(proof), proof.outcome);
    },
    call: async (request, signal) => {
      const foreign = foreignRuns.get(request.runId);
      if (foreign) {
        const invocation = z
          .object({ call: NormalizedCapabilityCallSchema, metadata: z.object({ idempotencyKey: z.string().optional() }) })
          .parse(request.input);
        request = { ...request, input: z.json().parse({ ...invocation, call: { ...invocation.call, target: foreign } }) };
      }
      const body = JSON.stringify(request);
      const proof = await signAppProof(input.runnerKey, { method: "POST", path: RUNNER_PATHS.call, body: new TextEncoder().encode(body) });
      const response = await route.request(`http://core.test${RUNNER_PATHS.call}`, {
        method: "POST",
        headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
        body,
        signal,
      });
      const value: unknown = await response.json();
      responses.push(value);
      expect(response.status).toBe(200);
      return RunnerCallResponseSchema.parse(value);
    },
  };
  const engines = [new FixtureEngine(enter), new FixtureEngine(enter)];
  const runners = engines.map((engine) => new Runner(bridge, engine, (code) => logs.push(code)));
  const running = runners.map((runner) => runner.start());
  return {
    logs,
    responses,
    engines,
    runners,
    foreignRuns,
    synchronizeNextPair() {
      arrivals = 0;
      pair = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async close() {
      release?.();
      for (const runner of runners) runner.stop();
      await Promise.all(running);
    },
  };
}
