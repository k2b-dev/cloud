import { type CapabilityDispatchDependencies, dispatchCapability } from "@valentinkolb/cloud/api";
import {
  CAPABILITY_MAX_REQUEST_BYTES,
  CapabilityAppIdSchema,
  CapabilityIdempotencyKeySchema,
  CapabilityLocalIdSchema,
} from "@valentinkolb/cloud/contracts";
import { type AuthenticatedWorkload, authenticateWorkloadCredential, invocationIssuanceMode } from "@valentinkolb/cloud/services/identity";
import { type Context, Hono } from "hono";
import { z } from "zod";

const HeaderMetadataSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[\x20-\x7e]+$/);
const InvocationMetadataSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    traceparent: HeaderMetadataSchema(512).optional(),
    tracestate: HeaderMetadataSchema(512).optional(),
    locale: HeaderMetadataSchema(100).optional(),
  })
  .strict();
const InvocationRequestSchema = z
  .object({
    kind: z.enum(["query", "action"]),
    targetApp: CapabilityAppIdSchema,
    capabilityId: CapabilityLocalIdSchema,
    input: z.unknown(),
    mandateId: z.string().uuid(),
    mandateRevision: z.number().int().positive(),
    idempotencyKey: CapabilityIdempotencyKeySchema.optional(),
    metadata: InvocationMetadataSchema.optional(),
  })
  .strict()
  .refine((request) => Object.hasOwn(request, "input"), { path: ["input"], message: "Input is required" });

type InvocationRequest = z.output<typeof InvocationRequestSchema>;
type InvocationBrokerDependencies = {
  authenticateWorkload: (params: {
    token: string | null | undefined;
    appId: string;
    scope: "identity:invoke";
  }) => Promise<AuthenticatedWorkload | null>;
  dispatchDependencies?: CapabilityDispatchDependencies;
  issuanceEnabled: () => boolean;
};

const bearerToken = (authorization: string | undefined): string | null => {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
};

const readRequest = async (request: Request): Promise<InvocationRequest | null> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CAPABILITY_MAX_REQUEST_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > CAPABILITY_MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = InvocationRequestSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const errorResponse = (c: Context, status: 400 | 401, code: "UNAUTHORIZED" | "VALIDATION_FAILED") =>
  c.json(
    {
      code,
      message: code === "UNAUTHORIZED" ? "A valid app workload credential is required" : "Invalid invocation request",
    },
    status,
    { "Cache-Control": "no-store" },
  );

const dispatchRequest = (source: Request, input: InvocationRequest): Request => {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  const metadata = input.metadata;
  if (metadata?.requestId) headers.set("x-request-id", metadata.requestId);
  if (metadata?.traceparent) headers.set("traceparent", metadata.traceparent);
  if (metadata?.tracestate) headers.set("tracestate", metadata.tracestate);
  if (metadata?.locale) headers.set("x-cloud-locale", metadata.locale);
  if (input.idempotencyKey) headers.set("idempotency-key", input.idempotencyKey);
  return new Request(source.url, { method: "POST", headers, signal: source.signal });
};

export const createIdentityInvocationRoutes = (dependencies: Partial<InvocationBrokerDependencies> = {}): Hono => {
  const authenticateWorkload = dependencies.authenticateWorkload ?? authenticateWorkloadCredential;
  return new Hono().post("/invoke", async (c) => {
    if (!(dependencies.issuanceEnabled ?? (() => invocationIssuanceMode() === "jwt"))()) {
      return c.json({ code: "INVOCATION_JWT_DISABLED", message: "Background capability invocation is not enabled" }, 503, {
        "Cache-Control": "no-store",
      });
    }
    const appId = CapabilityAppIdSchema.safeParse(c.req.header("X-Cloud-App-Id"));
    const token = bearerToken(c.req.header("Authorization"));
    if (!appId.success || !token) return errorResponse(c, 401, "UNAUTHORIZED");

    const workload = await authenticateWorkload({ token, appId: appId.data, scope: "identity:invoke" });
    if (!workload) return errorResponse(c, 401, "UNAUTHORIZED");

    const input = await readRequest(c.req.raw);
    if (!input) return errorResponse(c, 400, "VALIDATION_FAILED");

    const response = await dispatchCapability({
      request: dispatchRequest(c.req.raw, input),
      kind: input.kind === "query" ? "queries" : "actions",
      appId: input.targetApp,
      capabilityId: input.capabilityId,
      input: input.input,
      mandate: {
        mandateId: input.mandateId,
        mandateRevision: input.mandateRevision,
        ownerAppId: workload.appId,
      },
      callingAppId: workload.appId,
      locale: input.metadata?.locale,
      dependencies: dependencies.dispatchDependencies,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
};

export const identityInvocationRoutes = createIdentityInvocationRoutes();

export default identityInvocationRoutes;
