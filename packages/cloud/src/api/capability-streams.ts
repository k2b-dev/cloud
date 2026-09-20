import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { getCapability } from "../_internal/registry";
import { recordCapabilityExecution } from "../capabilities/executions";
import { exactStream } from "../capabilities/stream-body";
import type { CapabilityStream } from "../contracts/capabilities";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  CAPABILITY_ORIGIN_HEADER,
  CapabilityErrorSchema,
  CapabilityOriginSchema,
  CapabilityStreamSchema,
  CapabilityStreamStatusSchema,
  capabilityResultSchema,
} from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { capabilityInvocationOperation } from "../services/identity/invocation-operations";
import { signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { logger } from "../services/logging";
import { decryptSecret, encryptSecret } from "../services/secrets";
import { LOCALE_HEADER } from "../shared/locale";
import type { CapabilityDispatchDependencies } from "./capabilities";

const log = logger("capability-streams");

const Grant = z.object({
  purpose: z.literal("capability-stream-v2"),
  continuation: z.string().nullable(),
  origin: CapabilityOriginSchema.default("http"),
  appId: z.string(),
  kind: z.enum(["queries", "actions"]),
  capabilityId: z.string(),
  schemaHash: z.string(),
  authority: z.string(),
  stream: CapabilityStreamSchema,
  requestId: z.string(),
});
const binding = (authority: RequestAuthority) => JSON.stringify(invocationAuthorityFromRequest(authority));
export async function sealCapabilityStream(
  stream: CapabilityStream,
  params: {
    appId: string;
    kind: "queries" | "actions";
    capabilityId: string;
    schemaHash: string;
    authority: RequestAuthority;
    requestId: string;
    origin?: z.infer<typeof CapabilityOriginSchema>;
    continuation?: string;
  },
): Promise<CapabilityStream> {
  if (Buffer.byteLength(stream.id) > 2048) throw new Error("Provider stream ID exceeds 2 KiB");
  const grant = Grant.parse({
    ...params,
    purpose: "capability-stream-v2",
    continuation: params.continuation ?? null,
    authority: binding(params.authority),
    stream,
  });
  return CapabilityStreamSchema.parse({ ...stream, id: await encryptSecret(grant) });
}
const denied = (status = 403, code = "STREAM_DENIED") =>
  Response.json({ code, message: "Stream unavailable or not authorized" }, { status });

/** A transfer continues an already-authorized operation; it cannot manufacture a new Action. */
export async function dispatchCapabilityStream(
  request: Request,
  authority: RequestAuthority,
  verb: string,
  dependencies: CapabilityDispatchDependencies & {
    recordStreamExecution?: typeof recordCapabilityExecution;
    continuation?: string;
    allow?: (operation: { appId: string; capabilityId: string }) => Promise<boolean>;
  } = {},
): Promise<Response> {
  const id = request.headers.get("x-cloud-stream-id");
  if (!id || id.length > 8192 || !["read", "write", "status", "abort"].includes(verb)) return denied(400);
  let grant: z.infer<typeof Grant>;
  try {
    grant = Grant.parse(await decryptSecret(id));
  } catch {
    return denied();
  }
  try {
    if (grant.authority !== binding(authority)) return denied();
  } catch {
    return denied();
  }
  if (grant.continuation !== (dependencies.continuation ?? null)) return denied();
  if (dependencies.allow && !(await dependencies.allow(grant))) return denied();
  if (Date.parse(grant.stream.expiresAt) <= Date.now()) return denied(410, "STREAM_EXPIRED");
  if ((verb === "read") !== (grant.stream.direction === "read")) return denied();
  if (
    authority.credentialKind === "oauth" &&
    !authority.scopes.some((scope) => scope === "admin" || scope === (grant.kind === "actions" ? "write" : "read"))
  )
    return denied();
  const startedAt = new Date();
  let recorded = false;
  let destructive = false;
  const record = async (status: number, errorCode: string | null = null) => {
    if (recorded || (verb !== "read" && verb !== "write")) return;
    recorded = true;
    const actor = authority.actor;
    const actorId = actor.kind === "user" ? actor.user.id : actor.serviceAccount.id;
    const subject = authority.accessSubject;
    const subjectId = subject.type === "user" ? subject.userId : subject.serviceAccountId;
    await (dependencies.recordStreamExecution ?? recordCapabilityExecution)({
      requestId: grant.requestId,
      origin: grant.origin,
      appId: grant.appId,
      capability: `${grant.appId}.${grant.capabilityId}`,
      kind: grant.kind === "queries" ? "query" : "action",
      destructive,
      actorKind: actor.kind,
      actorId,
      userId: actor.kind === "user" ? actor.user.id : (actor.delegatedUser?.id ?? null),
      accessSubject: subjectId !== actorId ? { type: subject.type, id: subjectId } : null,
      status: status < 400 ? "succeeded" : status === 403 ? "denied" : status === 504 ? "timed_out" : "failed",
      errorCode,
      inputMeta: { type: "object", keys: [`stream.${verb}`], omittedKeys: 0 },
      outputMeta: status < 400 ? { type: "number", value: grant.stream.size } : null,
      startedAt,
      completedAt: new Date(),
    }).catch(() => log.error("Stream execution could not be recorded", { requestId: grant.requestId }));
  };
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]);
  try {
    const entry = await (dependencies.getCapability ?? getCapability)(grant.appId);
    const operation = entry?.manifest[grant.kind].find((item) => item.localId === grant.capabilityId);
    if (
      !entry ||
      !operation ||
      operation.schemaHash !== grant.schemaHash ||
      operation.stream?.direction !== grant.stream.direction ||
      grant.stream.size > operation.stream.maxBytes
    )
      return denied(409, "SCHEMA_MISMATCH");
    destructive = "destructive" in operation && operation.destructive;
    const signed = await (dependencies.withActiveSigner ?? withActiveIdentitySigner)(
      "invocation",
      (signer) =>
        (dependencies.signInvocation ?? signInvocationToken)({
          targetAppId: grant.appId,
          callingAppId: "core",
          operation: capabilityInvocationOperation(grant.kind, grant.capabilityId),
          schemaHash: operation.schemaHash,
          authority: invocationAuthorityFromRequest(authority),
          requestId: grant.requestId,
          signer,
          issuer: signer.issuer,
        }),
      { signal, timeoutMs: 30_000 },
    );
    const headers = new Headers({
      authorization: `Bearer ${signed.token}`,
      "x-request-id": grant.requestId,
      "x-cloud-capability-schema-hash": operation.schemaHash,
      "x-cloud-stream-offer": Buffer.from(JSON.stringify(grant.stream)).toString("base64url"),
      "content-type": "application/octet-stream",
    });
    headers.set(CAPABILITY_ORIGIN_HEADER, grant.origin);
    if (request.headers.has(LOCALE_HEADER)) headers.set(LOCALE_HEADER, request.headers.get(LOCALE_HEADER)!);
    if (request.headers.has("accept-language")) headers.set("accept-language", request.headers.get("accept-language")!);
    const body =
      verb === "write"
        ? exactStream(
            request.body ??
              new ReadableStream({
                start(c) {
                  c.close();
                },
              }),
            grant.stream.size,
          )
        : undefined;
    const response = await (dependencies.fetch ?? fetch)(
      `${entry.endpoint}/streams/${grant.kind}/${encodeURIComponent(grant.capabilityId)}/${verb}`,
      {
        method: "POST",
        headers,
        body,
        signal,
        redirect: "error",
        // @ts-expect-error Bun and Node stream request bodies use duplex.
        duplex: body ? "half" : undefined,
      },
    );
    log.info("Capability stream response", {
      requestId: grant.requestId,
      appId: grant.appId,
      capabilityId: grant.capabilityId,
      verb,
      status: response.status,
      bytes: grant.stream.size,
    });
    if (verb === "read" && response.ok) {
      if (!response.body) return denied(502, "STREAM_FAILED");
      const reader = exactStream(response.body, grant.stream.size).getReader();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                await record(200);
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch {
              await record(502, "STREAM_FAILED");
              controller.error(new Error("Incomplete capability stream"));
            }
          },
          async cancel(reason) {
            await reader.cancel(reason).catch(() => undefined);
            await record(499, "REQUEST_CANCELLED");
          },
        }),
        {
          headers: {
            "content-type": grant.stream.mediaType,
            "content-length": String(grant.stream.size),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
    const receipt = await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES);
    if (!receipt.ok) {
      await record(502, "STREAM_FAILED");
      return denied(502, "STREAM_FAILED");
    }
    if (response.ok) {
      const parsed = (verb === "write" ? capabilityResultSchema(z.unknown()) : CapabilityStreamStatusSchema).safeParse(receipt.data);
      if (!parsed.success) {
        await record(502, "STREAM_FAILED");
        return denied(502, "STREAM_FAILED");
      }
      const nested =
        verb === "write" ? parsed.data : "state" in parsed.data && parsed.data.state === "completed" ? parsed.data.result : null;
      if (nested && typeof nested === "object" && "stream" in nested) {
        await record(502, "STREAM_FAILED");
        return denied(502, "STREAM_FAILED");
      }
    }
    if (!response.ok) {
      const error = CapabilityErrorSchema.safeParse(receipt.data);
      const status = response.status === 401 ? 502 : response.status;
      await record(status, error.success ? error.data.code : "STREAM_FAILED");
      if (!error.success || response.status === 401) return denied(status, "STREAM_FAILED");
    } else await record(response.status);
    return Response.json(receipt.data, { status: response.status, headers: { "cache-control": "no-store" } });
  } catch {
    const status = request.signal.aborted ? 499 : signal.aborted ? 504 : 502;
    const code = status === 499 ? "REQUEST_CANCELLED" : status === 504 ? "DEADLINE_EXCEEDED" : "STREAM_FAILED";
    await record(status, code);
    return Response.json({ code, message: "Transfer interrupted; inspect write status before retrying" }, { status });
  }
}
