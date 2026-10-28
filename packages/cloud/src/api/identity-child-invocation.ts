import { Hono } from "hono";
import { decodeJwt } from "jose";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { createCapabilityDeadline, withCapabilityRequestTimeout } from "../_internal/capability-timeout";
import { authorizeCodeExecution } from "../ai/code-execution";
import { CAPABILITY_MAX_REQUEST_BYTES, CapabilityAppIdSchema, CapabilityLocalIdSchema } from "../contracts/capabilities";
import {
  isNestedSourceCurrent,
  matchesInvocationSubject,
  nestedInvocationLeases,
  resolveInvocationAuthority,
  verifyInvocationToken,
} from "../services/identity";
import { dispatchCapability } from "./capabilities";

const Input = z
  .object({
    targetApp: CapabilityAppIdSchema,
    capabilityId: CapabilityLocalIdSchema,
    input: z.unknown(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, "input"));
const denied = () =>
  Response.json(
    { code: "FORBIDDEN", message: "The parent invocation does not authorize this Query" },
    { status: 403, headers: { "cache-control": "no-store" } },
  );

/** One read-only dependency of an active Core dispatch, never a generic bearer exchange. */
export function createIdentityChildInvocationRoutes(
  dependencies: {
    verify?: typeof verifyInvocationToken;
    resolve?: typeof resolveInvocationAuthority;
    sourceCurrent?: typeof isNestedSourceCurrent;
    leases?: typeof nestedInvocationLeases;
    authorizeTurn?: (turn: { conversationId: string; turnId: string }, userId: string, query: string) => Promise<boolean>;
    dispatch?: typeof dispatchCapability;
  } = {},
) {
  const leases = dependencies.leases ?? nestedInvocationLeases;
  const authorizeTurn =
    dependencies.authorizeTurn ??
    (async (turn, userId, query) => {
      const { conversation } = await authorizeCodeExecution(turn.conversationId, turn.turnId, userId);
      return !conversation.allowedTools || conversation.allowedTools.includes(query);
    });
  return new Hono().post("/invoke-child", async (c) =>
    withCapabilityRequestTimeout(c, "query", async () => {
      let deadline: ReturnType<typeof createCapabilityDeadline> | undefined;
      try {
        const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
        if (!token || token.length > 4096) return denied();
        // Decode only routing expectations, then verify signature and every binding.
        const hint = decodeJwt(token);
        if (
          typeof hint.aud !== "string" ||
          !hint.aud.startsWith("app:") ||
          typeof hint.op !== "string" ||
          !(
            hint.op.startsWith("capability.query:") ||
            hint.op.startsWith("capability.action.run:") ||
            hint.op.startsWith("capability.action.review:")
          )
        )
          return denied();
        const parent = await (dependencies.verify ?? verifyInvocationToken)(token, {
          targetAppId: hint.aud.slice(4),
          operation: hint.op,
          schemaHash: typeof hint.schema_hash === "string" ? hint.schema_hash : null,
        });
        if (!parent || parent.parent_invocation_id || parent.exp * 1000 <= Date.now()) return denied();

        deadline = createCapabilityDeadline(parent.exp * 1000 - Date.now(), c.req.raw.signal);
        const body = await deadline.wait(() => readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES));
        const input = body.ok ? Input.safeParse(body.data) : null;
        if (!input?.success) return Response.json({ code: "VALIDATION_FAILED", message: "Invalid child Query input" }, { status: 400 });
        if (`app:${input.data.targetApp}` === parent.aud) return denied();
        c.req.raw.signal.throwIfAborted();
        const lease = await deadline.wait(() => leases.take(parent.jti));
        if (!lease || `app:${lease.appId}` !== parent.aud) return denied();
        deadline.clear();
        deadline = createCapabilityDeadline(Math.max(0, Math.min(lease.deadline, parent.exp * 1000) - Date.now()), c.req.raw.signal);
        const authority = await deadline.wait(() => (dependencies.resolve ?? resolveInvocationAuthority)(parent));
        if (!authority || !matchesInvocationSubject(parent, authority)) return denied();
        if (
          parent.credential_kind !== "mandate" &&
          lease.origin !== "assistant" &&
          (!lease.proof || !(await deadline.wait(() => (dependencies.sourceCurrent ?? isNestedSourceCurrent)(lease.proof!, parent))))
        )
          return denied();
        if (lease.origin === "assistant") {
          if (!lease.assistantTurn || parent.principal_type !== "user") return denied();
          if (
            !(await deadline.wait(() =>
              authorizeTurn(lease.assistantTurn!, parent.sub, `${input.data.targetApp}.${input.data.capabilityId}`),
            ))
          )
            return denied();
        }
        deadline.check();
        deadline.clear();
        const headers = new Headers({ "content-type": "application/json" });
        if (parent.request_id) headers.set("x-request-id", parent.request_id);
        for (const name of ["x-cloud-locale", "traceparent", "tracestate"]) {
          const value = c.req.header(name);
          if (value) headers.set(name, value);
        }
        const response = await (dependencies.dispatch ?? dispatchCapability)({
          request: new Request(c.req.url, { method: "POST", headers, signal: c.req.raw.signal }),
          kind: "queries",
          origin: lease.origin,
          authority,
          parentInvocation: parent,
          callingAppId: lease.appId,
          deadline: Math.min(lease.deadline, parent.exp * 1000),
          appId: input.data.targetApp,
          capabilityId: input.data.capabilityId,
          input: input.data.input,
          ...(parent.credential_kind === "mandate"
            ? {
                mandate: {
                  mandateId: parent.mandate_id!,
                  mandateRevision: parent.mandate_revision!,
                  ownerAppId: parent.act.sub.slice(4),
                },
              }
            : {}),
        });
        response.headers.set("cache-control", "no-store");
        return response;
      } catch {
        if (c.req.raw.signal.aborted)
          return Response.json({ code: "REQUEST_CANCELLED", message: "The request was cancelled" }, { status: 499 });
        if (deadline?.signal.aborted)
          return Response.json({ code: "DEADLINE_EXCEEDED", message: "The parent deadline was exceeded" }, { status: 504 });
        // Invalid signatures, unavailable live authority and store failures fail closed.
        return denied();
      } finally {
        deadline?.clear();
      }
    }),
  );
}
