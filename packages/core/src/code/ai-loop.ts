import { sql } from "@k2b/cloud";
import { type AiModelProfile, type AiResolvedModel, AiRunReadInput, AiRunViewInput, createAiRunFiles } from "@k2b/cloud/ai";
import {
  CodeBridgeRefusal,
  type CodeFileObservationHost,
  type CodeRunnerDispatchDependencies,
  dispatchCodeSdkCall,
  readCodeAiFile,
} from "@k2b/cloud/api";
import type { CodeAiToolBinding } from "@k2b/cloud/code";
import { createCodeAiTools } from "@k2b/cloud/code";
import { CodeRunTokenClaimsSchema } from "@k2b/cloud/code/run-token";
import { type CapabilityExecutionContext, CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { aiCostUnits, aiDecimalUnits } from "@k2b/cloud/shared";
import type { ContentPart, Provider } from "@k2b/nessi";
import type { GenerateRequest } from "@k2b/nessi/ai";
import { z } from "zod";
import { authorizeCodeCall, createCodeBridgeHost, readCodeOwnOrigins, requireCodeRunFence } from "./bridge";

/** Rehydrate only a signed direct Code invocation, fenced to its original generation and mandate. */
export async function codeAiRun(context: CapabilityExecutionContext) {
  const proof = context.actor.delegation;
  if (
    proof?.credentialKind !== "mandate" ||
    proof.workloadType !== "code.version" ||
    !proof.workloadRun ||
    !proof.workloadGeneration ||
    !proof.mandateId ||
    !proof.mandateRevision ||
    proof.parentInvocationId ||
    !["core", "runner"].includes(proof.callingAppId)
  )
    throw new CodeBridgeRefusal("code_ai_run_required", 403);
  const [run] = await sql<
    {
      code_id: string;
      version_id: string;
      entrypoint: string;
      bundle_hash: string;
      deadline_at: Date;
      manifest: unknown;
      reserved: string;
      calls_limit: number;
    }[]
  >`
    SELECT r.code_id,r.version_id,r.entrypoint,v.bundle_hash,r.deadline_at,v.manifest,r.ai_reserved_cost::text AS reserved,r.calls_limit
    FROM code.runs r JOIN code.versions v ON v.id=r.version_id JOIN code.codes c ON c.id=r.code_id
      JOIN auth.mandates m ON m.id=${proof.mandateId}::uuid AND m.workload_type='code.version' AND m.workload_id=r.version_id::text
        AND m.owner_app_id IN ('core','runner') AND m.revision=${proof.mandateRevision}
    WHERE r.id=${proof.workloadRun}::uuid AND r.version_id=${proof.workloadId}::uuid AND r.generation=${proof.workloadGeneration}
      AND r.deadline_at IS NOT NULL
      AND CASE WHEN c.owner_kind='person' THEN c.owner_user_id::text=${context.accessSubject.type === "user" ? context.accessSubject.userId : ""}
        ELSE c.service_account_id::text=${context.accessSubject.type === "service_account" ? context.accessSubject.serviceAccountId : ""} END`;
  if (!run) throw new CodeBridgeRefusal("runner_lease_lost", 409);
  const now = Math.floor(Date.now() / 1000);
  const claims = CodeRunTokenClaimsSchema.parse({
    ver: 1,
    token_use: "code_run",
    iss: "https://core.invalid",
    aud: "cloud-code-bridge",
    iat: now,
    nbf: now,
    exp: Math.floor(run.deadline_at.getTime() / 1000),
    codeId: run.code_id,
    versionId: run.version_id,
    entrypoint: run.entrypoint,
    runId: proof.workloadRun,
    generation: proof.workloadGeneration,
    mandateId: proof.mandateId,
    mandateRevision: proof.mandateRevision,
    bundleHash: run.bundle_hash,
  });
  await sql.begin((tx) => requireCodeRunFence(claims, tx));
  return { claims, manifest: CodeCheckedVersionManifestSchema.parse(run.manifest), reserved: run.reserved, maxTurns: run.calls_limit };
}

export async function prepareCodeAiLoop(
  input: {
    files?: Array<{ id: string; mediaType: string; size: number; name?: string }>;
    tools?: CodeAiToolBinding[];
    input: unknown;
    fileTools?: boolean;
  },
  context: CapabilityExecutionContext,
  operation: "core.ai.generate" | "core.ai.decide",
) {
  const run = await codeAiRun(context);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, run.claims.exp * 1000 - Date.now()))]);
  const request = new Request("https://core.invalid/code-ai", { signal, headers: { "accept-language": context.locale } });
  const host = createCodeBridgeHost();
  const dependencies: CodeRunnerDispatchDependencies = { host, ownOrigins: readCodeOwnOrigins };
  const reader = (model: Pick<AiResolvedModel, "profile">, maxInputTokens: number, describe: (parts: ContentPart[]) => Promise<string>) =>
    createAiRunFiles({
      model,
      maxInputTokens,
      describe,
      signal,
      read: (ref, maxBytes) => readCodeAiFile({ ref, maxBytes, request, claims: run.claims, dependencies }),
    });
  const check = () =>
    sql.begin((tx) =>
      authorizeCodeCall({ claims: run.claims, kind: "query", call: { capability: operation, target: null, refs: {}, input: {} } }, tx),
    );
  return {
    run,
    signal,
    reader,
    check,
    fileTool: <T>(name: "view_image" | "read_file", input: unknown, execute: () => Promise<T>) =>
      codeAiFileTool(run.claims, operation, name, input, execute, host),
    async tools(files: ReturnType<typeof createAiRunFiles>) {
      return createCodeAiTools({
        bindings: input.tools ?? [],
        permissions: run.manifest.permissions,
        registerFiles: files.add,
        requestId: context.requestId,
        invoke: async (invocation) => {
          const response = await dispatchCodeSdkCall({
            claims: run.claims,
            invocation,
            operationId: invocation.call.capability,
            request,
            dependencies,
          });
          const value: unknown = await response.json();
          const failure = z
            .object({ ok: z.literal(false), error: z.object({ code: z.string(), status: z.number().optional() }) })
            .safeParse(value);
          if (failure.success)
            throw new Error(`${failure.data.error.code}${failure.data.error.status ? ` (${failure.data.error.status})` : ""}`);
          return z.object({ ok: z.literal(true), data: z.unknown() }).parse(value).data;
        },
      });
    },
  };
}

/** Reserve the worst case of each model attempt from the existing Code reservation, including repairs and vision fallback. */
export function codeAiModelBudget(reserved: string, check?: () => Promise<unknown>) {
  let remaining = aiDecimalUnits(reserved);
  const reserve = (profile: AiModelProfile, input: number, output: number) => {
    if (!profile.pricing) return;
    const cost = aiCostUnits(profile.pricing, input, output);
    if (cost > remaining) throw Object.assign(new Error("code_ai_budget_limit"), { code: "code_ai_budget_limit" });
    remaining -= cost;
  };
  const wrap = (model: AiResolvedModel): AiResolvedModel => {
    const guard = (request: GenerateRequest) => {
      request.signal?.throwIfAborted();
      if (!model.profile.pricing) return;
      // Text and image token estimates are not upper bounds. Reserve the model's
      // full advertised input window so a provider cannot overspend the run budget.
      const input = model.profile.contextWindow ?? model.provider.contextWindow;
      if (input === undefined) throw Object.assign(new Error("The model needs a known context window."), { code: "code_ai_budget_limit" });
      const output =
        request.maxOutputTokens ??
        model.profile.maxOutputTokens ??
        model.profile.outputTokenLimit ??
        model.profile.contextWindow ??
        model.provider.contextWindow;
      if (output === undefined) throw Object.assign(new Error("The model needs a known token limit."), { code: "code_ai_budget_limit" });
      reserve(model.profile, input, output);
    };
    const provider: Provider = {
      ...model.provider,
      async *stream(request) {
        await check?.();
        guard(request);
        yield* model.provider.stream(request);
      },
    };
    return { ...model, provider };
  };
  return Object.assign(wrap, { reserve });
}

export const codeAiFileToolOperation = (name: "view_image" | "read_file") =>
  name === "view_image" ? "core.code.file.view" : "core.code.file.read";

/** Internal viewers use the same durable observer and policy fence without reserving AI a second time. */
export async function codeAiFileTool<T>(
  claims: Parameters<typeof readCodeAiFile>[0]["claims"],
  operation: "core.ai.generate" | "core.ai.decide",
  name: "view_image" | "read_file",
  input: unknown,
  execute: () => Promise<T>,
  host: CodeFileObservationHost,
): Promise<T> {
  let value: T | undefined;
  let failure: unknown;
  const args = name === "view_image" ? AiRunViewInput.parse(input) : AiRunReadInput.parse(input);
  const metadata = {
    ref: { mediaType: args.ref.mediaType, size: args.ref.size, ...(args.ref.name ? { name: args.ref.name } : {}) },
    ...("pages" in args && args.pages ? { pages: args.pages } : {}),
    ...("offset" in args ? { offset: args.offset, length: args.length } : {}),
  };
  const response = await host.withFileObservation({ claims, operation: codeAiFileToolOperation(name), input: metadata }, async () => {
    await sql.begin((tx) =>
      authorizeCodeCall({ claims, kind: "query", call: { capability: operation, target: null, refs: {}, input: {} } }, tx),
    );
    try {
      value = await execute();
      return Response.json({ ok: true, data: null });
    } catch (cause) {
      failure = cause;
      const parsed = z.object({ code: z.string().optional() }).safeParse(cause);
      throw new CodeBridgeRefusal(parsed.success && parsed.data.code ? parsed.data.code : "code_file_unavailable");
    }
  });
  if (failure) throw failure;
  if (value === undefined) {
    const failure = z.object({ error: z.object({ code: z.string() }) }).parse(await response.json());
    throw new Error(failure.error.code);
  }
  return value;
}
