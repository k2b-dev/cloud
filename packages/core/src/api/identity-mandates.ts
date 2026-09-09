import { CAPABILITY_MAX_REQUEST_BYTES, CapabilityAppIdSchema } from "@k2b/cloud/contracts";
import { respond } from "@k2b/cloud/server";
import { mandates } from "@k2b/cloud/services";
import { type AuthenticatedWorkload, authenticateWorkloadCredential } from "@k2b/cloud/services/identity";
import { type Context, Hono } from "hono";
import { z } from "zod";

const MandateParamsSchema = z.object({ mandateId: z.string().uuid() }).strict();
const ExpectedRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const NarrowPolicySchema = ExpectedRevisionSchema.extend({ policy: z.unknown() }).strict();
const RevokeSchema = ExpectedRevisionSchema.extend({ reason: z.string().trim().min(1).max(500) }).strict();

type OwnerMandateDependencies = {
  authenticateWorkload: typeof authenticateWorkloadCredential;
  service: Pick<typeof mandates, "confirm" | "get" | "pause" | "revoke" | "updatePolicy">;
};

const dependencies: OwnerMandateDependencies = {
  authenticateWorkload: authenticateWorkloadCredential,
  service: mandates,
};

const bearerToken = (authorization: string | undefined): string | null => {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
};

const authenticateOwner = async (
  c: Context,
  authenticate: typeof authenticateWorkloadCredential,
): Promise<AuthenticatedWorkload | null> => {
  const appId = CapabilityAppIdSchema.safeParse(c.req.header("X-Cloud-App-Id"));
  if (!appId.success) return null;
  return authenticate({ token: bearerToken(c.req.header("Authorization")), appId: appId.data, scope: "identity:invoke" });
};

const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T> | Response | null> => {
  const tooLarge = () => c.json({ code: "PAYLOAD_TOO_LARGE", message: "Mandate request exceeds the byte limit" }, 413);
  const request = c.req.raw;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CAPABILITY_MAX_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > CAPABILITY_MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = schema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
};

export const createIdentityMandateRoutes = (overrides: Partial<OwnerMandateDependencies> = {}): Hono => {
  const authenticate = overrides.authenticateWorkload ?? dependencies.authenticateWorkload;
  const service = overrides.service ?? dependencies.service;

  const ownerMandate = async (c: Context) => {
    const workload = await authenticateOwner(c, authenticate);
    if (!workload) return { error: c.json({ code: "UNAUTHORIZED", message: "A valid app workload credential is required" }, 401) };
    const params = MandateParamsSchema.safeParse(c.req.param());
    if (!params.success) return { error: c.json({ code: "VALIDATION_FAILED", message: "Invalid mandate id" }, 400) };
    const mandate = await service.get(params.data.mandateId);
    if (!mandate || mandate.ownerAppId !== workload.appId) {
      return { error: c.json({ code: "NOT_FOUND", message: "Mandate not found" }, 404) };
    }
    return { mandate, workload };
  };

  return new Hono()
    .get("/mandates/:mandateId", async (c) => {
      const owned = await ownerMandate(c);
      return "error" in owned ? owned.error : c.json(owned.mandate, 200, { "Cache-Control": "no-store" });
    })
    .post("/mandates/:mandateId/confirm", async (c) => {
      const owned = await ownerMandate(c);
      if ("error" in owned) return owned.error;
      const input = await body(c, ExpectedRevisionSchema);
      if (input instanceof Response) return input;
      if (!input) return c.json({ code: "VALIDATION_FAILED", message: "Invalid mandate confirmation" }, 400);
      return respond(c, () =>
        service.confirm({
          mandateId: owned.mandate.id,
          expectedRevision: input.expectedRevision,
          authority: { kind: "workload", ownerAppId: owned.workload.appId },
        }),
      );
    })
    .post("/mandates/:mandateId/policy", async (c) => {
      const owned = await ownerMandate(c);
      if ("error" in owned) return owned.error;
      const input = await body(c, NarrowPolicySchema);
      if (input instanceof Response) return input;
      if (!input) return c.json({ code: "VALIDATION_FAILED", message: "Invalid mandate policy update" }, 400);
      return respond(c, () =>
        service.updatePolicy({
          mandateId: owned.mandate.id,
          expectedRevision: input.expectedRevision,
          authority: { kind: "workload", ownerAppId: owned.workload.appId },
          policy: input.policy,
        }),
      );
    })
    .post("/mandates/:mandateId/pause", async (c) => {
      const owned = await ownerMandate(c);
      if ("error" in owned) return owned.error;
      const input = await body(c, ExpectedRevisionSchema);
      if (input instanceof Response) return input;
      if (!input) return c.json({ code: "VALIDATION_FAILED", message: "Invalid mandate pause" }, 400);
      return respond(c, () =>
        service.pause({
          mandateId: owned.mandate.id,
          expectedRevision: input.expectedRevision,
          authority: { kind: "workload", ownerAppId: owned.workload.appId },
        }),
      );
    })
    .post("/mandates/:mandateId/revoke", async (c) => {
      const owned = await ownerMandate(c);
      if ("error" in owned) return owned.error;
      const input = await body(c, RevokeSchema);
      if (input instanceof Response) return input;
      if (!input) return c.json({ code: "VALIDATION_FAILED", message: "Invalid mandate revocation" }, 400);
      return respond(c, () =>
        service.revoke({
          mandateId: owned.mandate.id,
          expectedRevision: input.expectedRevision,
          authority: { kind: "workload", ownerAppId: owned.workload.appId },
          reason: input.reason,
        }),
      );
    });
};

export default createIdentityMandateRoutes();
