import { aiConversations, authorizeBackgroundAction, hasRememberedAiToolApproval, rememberAiToolApproval } from "@k2b/cloud/ai";
import { CodeResourceId } from "@k2b/cloud/ai/browser";
import {
  type CapabilityCaller,
  capabilityReviewRememberScope,
  getCapabilityActionWording,
  getCapabilityCatalogApp,
  invokeCapability,
  reviewCapabilityAction,
  transferCapabilityStream,
} from "@k2b/cloud/capabilities/server";
import { CapabilityActionReviewDataSchema, CapabilityStreamSchema, capabilityActionPolicy } from "@k2b/cloud/contracts";
import {
  APPROVAL_MAX_WAIT_MS,
  approvalAssurance,
  approvalDecisionChannel,
  approvalReviewDigest,
  approvals,
} from "@k2b/cloud/services/approvals";
import { type SQL, sql } from "bun";
import { z } from "zod";
import { codeApprovalMessage } from "./code-approval-message";
import { LIMITS } from "./contracts";
import { CHECK_UNAVAILABLE } from "./html/check-contracts";
import { CloudError } from "./runtime/errors";
import { ArtifactError, type ArtifactIdentity, artifacts, user } from "./service";

export const RuntimeCapabilityRequest = z
  .object({
    id: z.uuid(),
    name: z
      .string()
      .regex(/^[a-z0-9-]+\.[a-zA-Z0-9_.-]+$/)
      .max(240),
    input: z.json(),
    artifactId: CodeResourceId.optional(),
    conversationId: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((value) => value.artifactId || value.conversationId, "A resource or current conversation is required");
const Prepared = z.object({
  appId: z.string(),
  localId: z.string(),
  kind: z.enum(["query", "action"]),
  schemaHash: z.string(),
  approval: z.enum(["none", "rememberable"]).nullable(),
  resource: z.object({ id: CodeResourceId, title: z.string() }).optional(),
  title: z.string(),
  review: CapabilityActionReviewDataSchema.nullable(),
  allowAlways: z.boolean(),
  scope: z.string().nullable(),
  /** Locale the person reviewed in; revalidation reviews in it again so a language switch is not a changed consequence. */
  locale: z.string().optional(),
});
type Request = z.infer<typeof RuntimeCapabilityRequest>;
type Row = {
  approval_id: string | null;
  id: string;
  request: unknown;
  prepared: unknown;
  status: string;
  result: unknown;
  created_at: Date;
};
const decoded = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

// Nested Assistant capabilities retain the authorized script's chat context.
// A request ID alone grants nothing: it must belong to this user, exact target,
// and a currently executing call; resource access is still checked by the target.
async function authorize(request: Request, identity: ArtifactIdentity) {
  return (await authorizeWithChat(request, identity)).resource;
}
async function authorizeWithChat(request: Request, identity: ArtifactIdentity) {
  const actor = user(identity);
  const resource = request.artifactId
    ? await artifacts.get(request.artifactId, { ...identity, conversationId: request.conversationId })
    : undefined;
  let conversationId: string | null = null;
  if (request.conversationId) {
    const conversation = z.uuid().safeParse(request.conversationId).success
      ? await aiConversations.getConversation({ conversationId: request.conversationId, ownerUserId: actor.id })
      : await aiConversations.getConversationByShortId({ shortId: request.conversationId, ownerUserId: actor.id });
    if (!conversation || conversation.archivedAt) throw new ArtifactError("ACCESS_DENIED");
    if (conversation.allowedTools && !conversation.allowedTools.includes(request.name)) throw new ArtifactError("ACCESS_DENIED");
    conversationId = conversation.id;
  }
  return { resource, conversationId };
}
async function operation(name: string, locale?: string | null) {
  const split = name.indexOf("."),
    appId = name.slice(0, split),
    localId = name.slice(split + 1);
  const catalog = await getCapabilityCatalogApp(appId, locale ?? undefined);
  if (!catalog.ok) throw new Error(catalog.error.message);
  if (!catalog.data) throw new ArtifactError("NOT_FOUND");
  const query = catalog.data.manifest.queries.find((item) => item.localId === localId);
  const action = catalog.data.manifest.actions.find((item) => item.localId === localId);
  if (Boolean(query) === Boolean(action)) throw new ArtifactError("INVALID_INPUT");
  return {
    appId,
    appName: catalog.data.appName,
    appIcon: catalog.data.appIcon,
    localId,
    operation: (query ?? action)!,
    action,
    policy: capabilityActionPolicy(catalog.data.manifest, localId),
    kind: query ? ("query" as const) : ("action" as const),
  };
}

export const runtimeCapabilities = {
  async check(
    input: { name: string; input: z.infer<ReturnType<typeof z.json>>; conversationId: string; artifactId?: string },
    identity: ArtifactIdentity,
    caller: CapabilityCaller,
  ) {
    const request = RuntimeCapabilityRequest.parse({ ...input, id: crypto.randomUUID() });
    const resource = await authorize(request, identity);
    if (resource && resource.permission !== "admin") throw new CloudError("unavailable", CHECK_UNAVAILABLE);
    // Discover first. Never prepare an action: even a review may have effects.
    const target = await operation(input.name, caller.locale);
    if (target.kind !== "query") throw new CloudError("unavailable", CHECK_UNAVAILABLE);
    const response = await this.prepare(request, identity, caller);
    if (response.status !== "completed") throw new CloudError("unavailable", CHECK_UNAVAILABLE);
    const result = z
      .object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ message: z.string() }).optional() })
      .parse(response.result);
    if (!result.ok) throw new Error(result.error?.message ?? "Read-only capability failed");
    const envelope = result.data;
    if (envelope && typeof envelope === "object" && "stream" in envelope && envelope.stream) {
      const stream = CapabilityStreamSchema.parse(envelope.stream);
      if (stream.direction !== "read") throw new CloudError("unavailable", CHECK_UNAVAILABLE);
      return { ...envelope, stream: { ...stream, callId: request.id } };
    }
    return envelope;
  },
  async stream(
    id: string,
    verb: "read" | "write" | "status" | "abort",
    body: ReadableStream<Uint8Array> | null,
    identity: ArtifactIdentity,
    caller: CapabilityCaller,
  ) {
    const actor = user(identity);
    const [row] = await sql<
      Row[]
    >`SELECT * FROM assistant.capability_calls WHERE id=${z.uuid().parse(id)}::uuid AND user_id=${actor.id}::uuid AND status='completed'`;
    if (!row) throw new ArtifactError("ACCESS_DENIED");
    const request = RuntimeCapabilityRequest.parse(decoded(row.request));
    await authorize(request, identity);
    const result = z.object({ ok: z.literal(true), data: z.object({ stream: CapabilityStreamSchema }) }).parse(decoded(row.result));
    const stream = result.data.stream;
    if (stream.size > LIMITS.inputFileBytes) throw new ArtifactError("INVALID_INPUT");
    return transferCapabilityStream(stream, verb, caller, verb === "write" ? (body ?? undefined) : undefined);
  },
  async prepare(
    input: unknown,
    identity: ArtifactIdentity,
    caller: CapabilityCaller,
    task?: { turnId: string; mandate: { id: string; revision: number } },
  ) {
    const request = RuntimeCapabilityRequest.parse(input),
      actor = user(identity);
    const { resource, conversationId } = await authorizeWithChat(request, identity);
    const untrusted = resource && resource.permission !== "admin";
    const target = await operation(request.name, caller.locale);
    const getReview = async () => {
      const response = await reviewCapabilityAction(
        { appId: target.appId, capabilityId: target.localId, input: request.input, signal: caller.signal },
        caller,
      );
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    };
    const review =
      task && target.action
        ? await authorizeBackgroundAction({
            ...task,
            appId: target.appId,
            capabilityId: target.localId,
            kind: target.kind,
            args: request.input,
            approval: target.action.approval,
            policy: target.policy,
            hasReview: target.action.review === true,
            action: target.operation.title,
            review: getReview,
            signal: caller.signal,
          })
        : target.action?.review
          ? await getReview()
          : null;
    const scope = review ? (capabilityReviewRememberScope(review, target.action?.approval) ?? null) : null;
    const prepared = Prepared.parse({
      appId: target.appId,
      localId: target.localId,
      kind: target.kind,
      schemaHash: target.operation.schemaHash,
      approval: target.action?.approval ?? null,
      title: target.operation.title,
      review,
      allowAlways: !untrusted && scope !== null,
      scope,
      locale: caller.locale ?? undefined,
      ...(untrusted ? { resource: { id: resource.id, title: resource.title } } : {}),
    });
    const remembered =
      !task &&
      !untrusted &&
      scope !== null &&
      (await hasRememberedAiToolApproval({ actorUserId: actor.id }, { toolName: request.name, approvalScope: scope, conversationId }));
    // Only the managed host supplies task context; Core also checks the mandate on every dispatch.
    const automatic = Boolean(task) || (!untrusted && (!target.action || target.action.approval === "none" || remembered));
    const wording =
      !automatic && target.action ? await getCapabilityActionWording(target.appId, target.localId, caller.locale ?? undefined) : null;
    const response = {
      status: "approval" as const,
      id: request.id,
      name: request.name,
      input: request.input,
      appName: target.appName,
      appIcon: target.appIcon,
      ...prepared,
      // Only enrich the browser copy. The stored snapshot and approval digest keep the app's original review.
      review:
        review && "sentence" in review && !review.ask && target.policy && "ask" in target.policy
          ? { ...review, ask: target.policy.ask }
          : review,
      ...(wording?.sentences ? { sentences: wording.sentences } : {}),
      ...(wording?.fields?.length ? { fields: [...wording.fields] } : {}),
    };
    await sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(hashtext(${"assistant-capabilities:" + actor.id}))`;
      const abandoned = await db<{ approval_id: string | null }[]>`UPDATE assistant.capability_calls SET status='abandoned'
        WHERE user_id=${actor.id}::uuid AND status IN ('pending','running') AND created_at < now()-interval '1 day'
        RETURNING approval_id`;
      await approvals.cancel(
        abandoned.flatMap((call) => (call.approval_id ? [call.approval_id] : [])),
        db,
      );
      const [pending] = await db<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM assistant.capability_calls WHERE user_id=${actor.id}::uuid AND status IN ('pending','running')`;
      if (pending!.count >= LIMITS.pendingRequests) throw new ArtifactError("TOO_MANY_REQUESTS");
      await db`INSERT INTO assistant.capability_calls(id,user_id,artifact_id,conversation_id,request,prepared)
        VALUES(${request.id}::uuid,${actor.id}::uuid,(SELECT id FROM assistant.artifacts WHERE short_id=${request.artifactId ?? null}),${conversationId},(${JSON.stringify(request)}::text)::jsonb,(${JSON.stringify(prepared)}::text)::jsonb)`;
      if (!automatic) {
        const approval = await requestApprovalRecord(request, prepared, actor.id, db, {
          sentence: codeApprovalMessage(response, caller.locale ?? "en"),
          title: resource?.title ?? null,
          expiresInMs: APPROVAL_MAX_WAIT_MS,
        });
        // An approval request already holds this call ID, so the ID is reused; it never inherits that decision.
        if (!approval.ok) throw new ArtifactError("CONFLICT");
        await db`UPDATE assistant.capability_calls SET approval_id=${approval.id}::uuid WHERE id=${request.id}::uuid`;
      }
      // Only recent completed transport results are needed; canonical execution
      // history remains in the platform's capabilities.executions table.
      await db`DELETE FROM assistant.capability_calls WHERE id IN (SELECT id FROM assistant.capability_calls
        WHERE user_id=${actor.id}::uuid AND status IN ('completed','denied','abandoned') ORDER BY created_at DESC OFFSET ${LIMITS.logs})`;
    });
    if (automatic) return resolveCapability(request.id, { approved: true }, identity, caller, true, Boolean(task));
    return response;
  },
  async resolve(id: string, decision: { approved: boolean; remember?: "always" }, identity: ArtifactIdentity, caller: CapabilityCaller) {
    return resolveCapability(id, decision, identity, caller);
  },
};

async function resolveCapability(
  id: string,
  decision: { approved: boolean; remember?: "always" },
  identity: ArtifactIdentity,
  caller: CapabilityCaller,
  automatic = false,
  background = false,
) {
  z.uuid().parse(id);
  const actor = user(identity);
  const [row] = await sql<Row[]>`SELECT * FROM assistant.capability_calls WHERE id=${id}::uuid AND user_id=${actor.id}::uuid`;
  if (!row) throw new ArtifactError("NOT_FOUND");
  // Declining has no effect to authorize or review. It must still work when
  // access was revoked or the target application is temporarily unavailable.
  if (!decision.approved && row.status === "pending") {
    const denied = await claimExecution(row, decision, identity, null, false);
    if (!denied) throw new ArtifactError("CONFLICT");
    return { status: "denied" as const };
  }
  const request = RuntimeCapabilityRequest.parse(decoded(row.request)),
    prepared = Prepared.parse(decoded(row.prepared));
  const resource = await authorize(request, identity);
  if (resource && resource.permission !== "admin" && !prepared.resource) throw new ArtifactError("CONFLICT");
  if (row.status === "completed") return { status: "completed" as const, result: decoded(row.result) };
  if (row.status !== "pending") throw new ArtifactError("CONFLICT");
  const target = await operation(request.name, caller.locale);
  if (
    target.operation.schemaHash !== prepared.schemaHash ||
    target.kind !== prepared.kind ||
    (target.action?.approval ?? null) !== prepared.approval
  )
    throw new ArtifactError("CONFLICT");
  // Approval applies to the reviewed consequence, not a changed action.
  // The routine gate already reviewed this call. Interactive approvals still revalidate their reviewed consequence.
  let currentReview: z.infer<typeof CapabilityActionReviewDataSchema> | null = background ? prepared.review : null;
  if (!background && target.action?.review) {
    const response = await reviewCapabilityAction(
      { appId: target.appId, capabilityId: target.localId, input: request.input, signal: caller.signal },
      { ...caller, locale: prepared.locale ?? caller.locale },
    );
    if (!response.ok) throw new Error(response.error.message);
    currentReview = CapabilityActionReviewDataSchema.parse(response.data);
  }
  if (approvalReviewDigest(currentReview) !== approvalReviewDigest(prepared.review)) throw new ArtifactError("CONFLICT");
  if (decision.remember && (!prepared.allowAlways || (resource && resource.permission !== "admin")))
    throw new ArtifactError("INVALID_INPUT");
  const updated = await claimExecution(row, decision, identity, currentReview, automatic);
  if (!updated) throw new ArtifactError("CONFLICT");
  if (!decision.approved) return { status: "denied" as const };
  // The capability call ID is the request ID of the execution that follows, so both audit trails join.
  if (decision.remember && prepared.scope)
    await rememberAiToolApproval(
      { actorUserId: actor.id, actor: identity.actor, requestId: id },
      { toolName: request.name, approvalScope: prepared.scope },
    );
  const result = await invokeCapability(
    {
      appId: prepared.appId,
      capabilityId: prepared.localId,
      kind: prepared.kind,
      input: request.input,
      ...(target.action?.idempotency === "required" ? { idempotencyKey: `code-${id}` } : {}),
      signal: caller.signal,
    },
    { ...caller, requestId: id },
  );
  await sql`UPDATE assistant.capability_calls SET status='completed',result=(${JSON.stringify(result)}::text)::jsonb WHERE id=${id}::uuid`;
  return { status: "completed" as const, result };
}

async function requestApprovalRecord(
  request: Request,
  prepared: z.infer<typeof Prepared>,
  userId: string,
  db: SQL,
  options: { expiresInMs: number; sentence?: string; title?: string | null },
) {
  return approvals.request(
    {
      appId: prepared.appId,
      action: prepared.localId,
      approvalScope: prepared.scope,
      requester: {
        kind: "studio_app",
        ref: request.id,
        appId: "assistant",
        title: options.title ?? prepared.resource?.title ?? null,
      },
      subjectId: userId,
      approverUserId: userId,
      // Like a chat, a rememberable Action whose review leaves out the scope for these arguments asks as `confirm`.
      assurance: approvalAssurance(prepared.scope !== null),
      // Legacy calls retain only the app ID and local title; declining must work without the catalog.
      sentence:
        options.sentence ??
        codeApprovalMessage(
          {
            status: "approval",
            id: request.id,
            name: request.name,
            input: request.input,
            appName: prepared.appId,
            appIcon: "",
            ...prepared,
          },
          prepared.locale ?? "en",
        ),
      review: prepared.review,
      input: request.input,
      expiresInMs: options.expiresInMs,
    },
    db,
  );
}

async function claimExecution(
  row: Row,
  decision: { approved: boolean },
  identity: ArtifactIdentity,
  review: z.infer<typeof CapabilityActionReviewDataSchema> | null,
  automatic: boolean,
): Promise<boolean> {
  const actor = user(identity);
  return sql.begin(async (db) => {
    const [current] = await db<Row[]>`SELECT * FROM assistant.capability_calls
      WHERE id=${row.id}::uuid AND user_id=${actor.id}::uuid FOR UPDATE`;
    if (!current || current.status !== "pending") return false;
    if (!automatic) {
      let approvalId = current.approval_id;
      if (!approvalId) {
        const approval = await requestApprovalRecord(
          RuntimeCapabilityRequest.parse(decoded(current.request)),
          Prepared.parse(decoded(current.prepared)),
          actor.id,
          db,
          // A call from before the upgrade keeps the day it had to wait; an older one can only be declined.
          { expiresInMs: current.created_at.getTime() + APPROVAL_MAX_WAIT_MS - Date.now() },
        );
        if (!approval.ok) return false;
        approvalId = approval.id;
        await db`UPDATE assistant.capability_calls SET approval_id=${approvalId}::uuid WHERE id=${row.id}::uuid AND approval_id IS NULL`;
      }
      const via = approvalDecisionChannel({ credentialKind: identity.credentialKind, actor: identity.actor, client: identity.client });
      // A relay may reject, but only the person can approve a pending request in the chat.
      if (decision.approved && via === "invocation" && (await approvals.get(approvalId, db))?.status === "pending") return false;
      const decided = await approvals.decide(approvalId, decision, { userId: actor.id, via }, db);
      if (
        !decided.ok &&
        !(!decision.approved && (decided.code === "EXPIRED" || (decided.code === "ALREADY_DECIDED" && decided.status === "expired")))
      )
        return false;
      if (decision.approved) {
        const request = RuntimeCapabilityRequest.parse(decoded(current.request));
        const consumed = await approvals.consume(
          approvalId,
          { input: request.input, review, requester: { kind: "studio_app", ref: row.id } },
          db,
        );
        if (!consumed.ok) return false;
      }
    }
    const updated = await db`UPDATE assistant.capability_calls SET status=${decision.approved ? "running" : "denied"}
      WHERE id=${row.id}::uuid AND user_id=${actor.id}::uuid AND status='pending' RETURNING id`;
    return updated.length > 0;
  });
}
