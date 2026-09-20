import { type Context, Hono } from "hono";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { dispatchCapability } from "../api/capabilities";
import { dispatchCapabilityStream } from "../api/capability-streams";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { type AuthContext, getLocale, type RequestAuthority } from "../server";
import { requireInvocation } from "../server/middleware/invocation";
import { codeCapabilityOperation } from "./code-capability-transport";
import { aiConversations } from "./store";

const Input = z
  .object({ input: z.unknown() })
  .strict()
  .refine((value) => Object.hasOwn(value, "input"));
const denied = () => Response.json({ code: "ACCESS_DENIED", message: "Code execution is no longer authorized" }, { status: 403 });

/** Core-only continuation of a foreground code turn, not a general invocation exchange. */
export function createCodeCapabilityRoutes(
  dependencies: {
    invocation?: Parameters<typeof requireInvocation>[1];
    store?: Pick<typeof aiConversations, "getConversation" | "getActiveTurn" | "getTurnRunConfig">;
    dispatch?: typeof dispatchCapability;
    stream?: typeof dispatchCapabilityStream;
  } = {},
) {
  const store = dependencies.store ?? aiConversations;
  const authority = (c: Context<AuthContext>): RequestAuthority => ({
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    credentialKind: "session",
    scopes: [],
  });
  const invoke = async (c: Context<AuthContext>, review = false) => {
    const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
    const input = body.ok ? Input.safeParse(body.data) : null;
    if (!input?.success) return Response.json({ code: "VALIDATION_FAILED", message: "Invalid capability input" }, { status: 400 });
    const conversation = await store.getConversation({ conversationId: c.req.param("conversationId")! });
    const appId = c.req.param("appId")!;
    const capabilityId = c.req.param("capabilityId")!;
    if (conversation?.allowedTools && !conversation.allowedTools.includes(`${appId}.${capabilityId}`)) return denied();
    return (dependencies.dispatch ?? dispatchCapability)({
      request: c.req.raw,
      authority: authority(c),
      origin: "assistant",
      review,
      kind: review || c.req.param("kind") === "actions" ? "actions" : "queries",
      appId,
      capabilityId,
      input: input.data.input,
      locale: getLocale(c),
    });
  };
  return new Hono<AuthContext>()
    .use(
      "/:conversationId/:turnId/*",
      requireInvocation((c) => {
        const conversationId = z.uuid().safeParse(c.req.param("conversationId"));
        const turnId = z.uuid().safeParse(c.req.param("turnId"));
        return conversationId.success && turnId.success
          ? { targetAppId: "core", operation: codeCapabilityOperation(conversationId.data, turnId.data), schemaHash: null }
          : null;
      }, dependencies.invocation),
    )
    .use("/:conversationId/:turnId/*", async (c, next) => {
      const actor = c.get("actor");
      if (actor.kind !== "user" || actor.delegation?.callingAppId !== "assistant" || actor.delegation.credentialKind !== "session")
        return denied();
      const conversationId = c.req.param("conversationId")!;
      const turnId = c.req.param("turnId")!;
      const [conversation, active, config] = await Promise.all([
        store.getConversation({ conversationId, ownerUserId: actor.user.id }),
        store.getActiveTurn({ conversationId }),
        store.getTurnRunConfig({ conversationId, turnId }),
      ]);
      if (
        !conversation ||
        conversation.createdByUserId !== actor.user.id ||
        conversation.archivedAt ||
        !active ||
        active.turn.id !== turnId ||
        !["running", "waiting_for_action"].includes(active.turn.status) ||
        !config ||
        config.kind === "compact" ||
        config.background ||
        config.mandate
      )
        return denied();
      c.header("Cache-Control", "no-store");
      await next();
    })
    .post("/:conversationId/:turnId/capabilities/v1/actions/:appId/:capabilityId/review", (c) => invoke(c, true))
    .post("/:conversationId/:turnId/capabilities/v1/:kind{queries|actions}/:appId/:capabilityId", (c) => invoke(c))
    .post("/:conversationId/:turnId/capabilities/v1/streams/:verb", (c) =>
      (dependencies.stream ?? dispatchCapabilityStream)(c.req.raw, authority(c), c.req.param("verb")),
    );
}
