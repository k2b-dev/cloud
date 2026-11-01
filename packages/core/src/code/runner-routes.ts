import { sql } from "@k2b/cloud";
import { authenticateSignedAppRequest, CodeBridgeRefusal, type CodeRunnerDispatchDependencies } from "@k2b/cloud/api";
import { verifyCodeRunToken } from "@k2b/cloud/code/run-token";
import {
  RUNNER_PATHS,
  RunnerBundleRequestSchema,
  RunnerCompleteRequestSchema,
  RunnerFetchRequestSchema,
  RunnerLeaseProofSchema,
} from "@k2b/cloud/code/runner";
import { REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "@k2b/cloud/server";
import { Hono } from "hono";
import { requireCodeRunFence } from "./bridge";
import { completeCodeRun, heartbeatCodeRun } from "./scheduling";
import { fetchCodeRuns, readCodeRunnerConfig } from "./scheduling-runtime";

/** Private, signed runner-only routes. Every Core replica uses the same durable lease fence and signing key ring. */
export function createCodeRunnerRoutes(options: Pick<CodeRunnerDispatchDependencies, "appProof" | "token"> = {}) {
  const router = new Hono();
  for (const path of [RUNNER_PATHS.config, RUNNER_PATHS.fetch, RUNNER_PATHS.bundle, RUNNER_PATHS.heartbeat, RUNNER_PATHS.complete]) {
    router.post(path, async (c) => {
      const signed = await authenticateSignedAppRequest(c, "identity:invoke", {
        // The enrolled app key is shared by the fleet; per-Code/run limits, not one key's bootstrap rate, own admission.
        admit: async () => ({ limited: false, remaining: 0, resetIn: 0 }),
        ...options.appProof,
      });
      if (signed instanceof Response) return signed;
      if (signed.appId !== "runner") return c.json({ code: "code_runner_required" }, 403);
      try {
        // authenticateSignedAppRequest already verified and bounded the exact body.
        const body: unknown = await c.req.json();
        if (path === RUNNER_PATHS.config) return c.json(await readCodeRunnerConfig());
        if (path === RUNNER_PATHS.fetch) {
          const parsed = RunnerFetchRequestSchema.safeParse(body);
          if (!parsed.success) return c.json({ code: "code_invalid_call" }, 400);
          const config = await readCodeRunnerConfig();
          setRequestTimeout(c, Math.ceil((config.pollMs + config.transportMs) / 1000));
          try {
            return c.json(await fetchCodeRuns(parsed.data, c.req.raw.signal));
          } finally {
            setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
          }
        }
        const proof = RunnerLeaseProofSchema.safeParse(
          body && typeof body === "object"
            ? {
                runId: "runId" in body ? body.runId : null,
                generation: "generation" in body ? body.generation : null,
                token: "token" in body ? body.token : null,
              }
            : null,
        );
        if (!proof.success) return c.json({ code: "code_invalid_call" }, 400);
        const claims = await verifyCodeRunToken(proof.data.token, options.token);
        if (!claims) return c.json({ code: "code_invalid_token" }, 403);
        if (claims.runId !== proof.data.runId || claims.generation !== proof.data.generation)
          return c.json({ code: "runner_lease_lost" }, 409);
        if (path === RUNNER_PATHS.heartbeat) {
          if (!RunnerLeaseProofSchema.safeParse(body).success) return c.json({ code: "code_invalid_call" }, 400);
          return c.json(await heartbeatCodeRun(claims));
        }
        if (path === RUNNER_PATHS.complete) {
          const parsed = RunnerCompleteRequestSchema.safeParse(body);
          if (!parsed.success) return c.json({ code: "code_invalid_call" }, 400);
          await completeCodeRun(claims, parsed.data.outcome);
          return c.body(null, 204);
        }
        const parsed = RunnerBundleRequestSchema.safeParse(body);
        if (!parsed.success) return c.json({ code: "code_invalid_call" }, 400);
        if (parsed.data.bundleHash !== claims.bundleHash) return c.json({ code: "code_bundle_mismatch" }, 403);
        const bundle = await sql.begin(async (db) => {
          await requireCodeRunFence(claims, db);
          const [version] = await db<{ bundle: string }[]>`SELECT bundle FROM code.versions WHERE id=${claims.versionId}::uuid
            AND code_id=${claims.codeId} AND bundle_hash=${claims.bundleHash}`;
          return version?.bundle;
        });
        if (bundle === undefined) return c.json({ code: "code_bundle_mismatch" }, 403);
        c.header("Content-Type", "text/javascript; charset=utf-8");
        return c.body(bundle);
      } catch (error) {
        if (error instanceof CodeBridgeRefusal) return c.json({ code: error.code }, error.status);
        if (error instanceof SyntaxError) return c.json({ code: "code_invalid_call" }, 400);
        return c.json({ code: "code_runner_unavailable" }, 503);
      }
    });
  }
  return router;
}
