import { createHash } from "node:crypto";
import type { ToolContext } from "@k2b/nessi";
import { capabilityActionReceiptIssues, capabilityQueryChecksActionOutcome } from "../_internal/capability-reviews";
import { type CapabilityDispatchDependencies, dispatchCapability } from "../api/capabilities";
import { capabilityValueMeta, recordCapabilityExecution } from "../capabilities/executions";
import {
  type CapabilityActionCallReview,
  CapabilityActionCheckSchema,
  type CapabilityActionManifest,
  type CapabilityActionReviewData,
  CapabilityActionReviewDataSchema,
} from "../contracts/capabilities";
import type { RequestActor } from "../server";
import type { AccessSubject } from "../server/services/access";
import { isAccountCategoryAllowed } from "../services/account-category-policy";
import { isAccountExpired } from "../services/account-model";
import { accounts } from "../services/accounts";
import { withoutAdminRole } from "../services/session/user";
import { LOCALE_HEADER } from "../shared/locale";
import type { AiActionCheck } from "./action-review";
import type { AiCapabilityCatalogEntry } from "./capabilities";
import { aiToolAudit } from "./tool-audit";
import type { AiConversationService } from "./types";

type CapabilityActor = Extract<RequestActor, { kind: "user" }>;

export const resolveAiCapabilityActor = async (input: {
  conversationId: string;
  persistedActor?: RequestActor;
  store: Pick<AiConversationService, "getConversation">;
  getUser?: typeof accounts.users.get;
}): Promise<{ actor: CapabilityActor; accessSubject: AccessSubject }> => {
  if (input.persistedActor?.kind !== "user") throw new Error("Cloud capabilities require a current user-backed actor.");
  const conversation = await input.store.getConversation({ conversationId: input.conversationId });
  if (!conversation?.createdByUserId || conversation.createdByUserId !== input.persistedActor.user.id) {
    throw new Error("Cloud capability actor no longer owns this conversation.");
  }

  const user = await (input.getUser ?? accounts.users.get)({ id: conversation.createdByUserId });
  if (!user || isAccountExpired(user.accountExpires)) throw new Error("Cloud capability actor is no longer active.");
  if (!(await isAccountCategoryAllowed(user))) throw new Error("Cloud capability actor category is disabled.");
  // A turn started in the mobile app keeps its limits: no administrator role, and invocations say so.
  if (input.persistedActor.sessionKind === "app") {
    return { actor: { kind: "user", user: withoutAdminRole(user), sessionKind: "app" }, accessSubject: { type: "user", userId: user.id } };
  }
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
};

export class AiCapabilityExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AiCapabilityExecutionError";
  }
}

const idempotencyKey = (conversationId: string, callId: string): string =>
  `ai-${createHash("sha256").update(`${conversationId}\0${callId}`).digest("hex")}`;

const MAX_VALIDATION_ISSUES = 8;
const MAX_VALIDATION_ISSUE_CHARS = 300;

const validationIssueText = (details: unknown): string => {
  if (!details || typeof details !== "object" || !("issues" in details) || !Array.isArray(details.issues)) return "";
  const issues = details.issues.slice(0, MAX_VALIDATION_ISSUES).flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const rawPath = "path" in issue ? issue.path : undefined;
    const path = Array.isArray(rawPath)
      ? rawPath.filter((part): part is string | number => typeof part === "string" || typeof part === "number").join(".")
      : typeof rawPath === "string"
        ? rawPath
        : "input";
    const message = "message" in issue && typeof issue.message === "string" ? issue.message : "Invalid value";
    return [`${path || "input"}: ${message}`.slice(0, MAX_VALIDATION_ISSUE_CHARS)];
  });
  return issues.length > 0 ? ` Input issues: ${issues.join("; ")}` : "";
};

const parseCapabilityResponse = async (response: Response): Promise<unknown> => {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; details?: unknown } | null;
  if (response.ok) return body;
  const code = typeof body?.code === "string" ? body.code : "CAPABILITY_FAILED";
  const message = typeof body?.message === "string" ? body.message : "Capability execution failed";
  const issueText = code === "VALIDATION_FAILED" ? validationIssueText(body?.details) : "";
  throw new AiCapabilityExecutionError(code, response.status, `${message}${issueText}`);
};

type AiCapabilityCall = {
  conversationId: string;
  turnId?: string;
  authority: { actor: CapabilityActor; accessSubject: AccessSubject };
  locale?: string;
  entry: AiCapabilityCatalogEntry;
  args: unknown;
  context: ToolContext;
  mandate?: { id: string; revision: number };
  /** Set only by the capability tool after its explicit approval request resolved true. */
  actionApproval?: "approved";
  dependencies?: CapabilityDispatchDependencies & {
    dispatch?: typeof dispatchCapability;
  };
};

const dispatchAiCapability = async (
  input: Omit<AiCapabilityCall, "context"> & { context: Pick<ToolContext, "callId" | "signal"> },
  review: boolean,
): Promise<unknown> => {
  if (input.authority.accessSubject.type !== "user" || input.authority.accessSubject.userId !== input.authority.actor.user.id) {
    throw new Error("Cloud capability authority is inconsistent.");
  }
  const dispatch = input.dependencies?.dispatch ?? dispatchCapability;
  const headers = new Headers();
  if (input.locale) headers.set(LOCALE_HEADER, input.locale);
  const action = input.entry.kind === "action" ? (input.entry.operation as CapabilityActionManifest) : null;
  // One request id per dispatch links the tool call, the platform execution
  // record, and the target app's own audit rows.
  const requestId = crypto.randomUUID();
  headers.set("x-request-id", requestId);
  const key =
    !review && action?.idempotency === "required" && input.context.callId
      ? idempotencyKey(input.conversationId, input.context.callId)
      : null;
  if (key) headers.set("idempotency-key", key);
  if (!review && input.turnId && input.context.callId) {
    await aiToolAudit.noteCapabilityDispatch({
      conversationId: input.conversationId,
      turnId: input.turnId,
      callId: input.context.callId,
      toolName: input.entry.name,
      requestId,
      idempotencyKey: key,
    });
  }
  const request = new Request("http://cloud.internal/api/ai/capability", {
    method: "POST",
    headers,
    signal: input.context.signal,
  });
  return await parseCapabilityResponse(
    await dispatch({
      request,
      kind: input.entry.kind === "query" ? "queries" : "actions",
      origin: "assistant",
      review,
      appId: input.entry.appId,
      capabilityId: input.entry.operation.localId,
      input: input.args,
      authority: {
        actor: input.authority.actor,
        accessSubject: input.authority.accessSubject,
        credentialKind: "session",
        scopes: [],
      },
      mandate: input.mandate
        ? {
            mandateId: input.mandate.id,
            mandateRevision: input.mandate.revision,
            ownerAppId: "core",
            ...(!review && input.actionApproval ? { actionApproval: input.actionApproval } : {}),
          }
        : undefined,
      dependencies: input.dependencies,
    }),
  );
};

export const reviewAiCapability = async (input: AiCapabilityCall): Promise<CapabilityActionReviewData | null> => {
  if (input.entry.kind !== "action" || !(input.entry.operation as CapabilityActionManifest).review) return null;
  return CapabilityActionReviewDataSchema.parse(await dispatchAiCapability(input, true));
};

export const executeAiCapability = (input: AiCapabilityCall): Promise<unknown> => dispatchAiCapability(input, false);

/** Run only the app-owned read-only outcome Query, once. Invalid answers stay unknown and remain recoverable. */
export const checkAiCapability = async (
  input: Omit<AiCapabilityCall, "args" | "actionApproval" | "context"> & {
    context: Pick<ToolContext, "callId" | "signal">;
    check: NonNullable<CapabilityActionCallReview["check"]>;
    /** The app's catalog, in which the check Query is looked up; the caller builds it (no import cycle). */
    catalog: readonly AiCapabilityCatalogEntry[];
  },
): Promise<AiActionCheck> => {
  try {
    const query = input.catalog.find(
      (entry) => entry.appId === input.entry.appId && entry.kind === "query" && entry.operation.localId === input.check.query,
    );
    if (!query || "idempotency" in query.operation || !capabilityQueryChecksActionOutcome(query.operation))
      throw new Error("Action outcome Query is unavailable.");
    // The Action's audit keeps its own dispatch identity; the Query has its separate platform execution record.
    const result = await dispatchAiCapability({ ...input, turnId: undefined, entry: query, args: input.check.input }, false);
    if (!result || typeof result !== "object" || !("data" in result)) throw new Error("Invalid outcome check envelope.");
    const checked = CapabilityActionCheckSchema.parse(result.data);
    if (checked.receipt && capabilityActionReceiptIssues(checked.receipt, "links" in result ? result.links : undefined).length)
      throw new Error("Invalid outcome check receipt.");
    return { state: checked.outcome, ...(checked.receipt ? { receipt: checked.receipt } : {}), at: new Date().toISOString() };
  } catch {
    return { state: "failed", at: new Date().toISOString() };
  }
};

/** A check settles only what the app knows; it never authorizes another Action attempt. */
export const aiCapabilityCheckResult = (check: AiActionCheck): unknown => {
  if (check.state === "done")
    return {
      data: null,
      ...(check.receipt ? { receipt: check.receipt } : {}),
      outcomeCheck: "done",
      message: "The app's check confirmed the Action happened. Do not run it again.",
    };
  if (check.state === "not_done")
    throw new AiCapabilityExecutionError(
      "ACTION_NOT_DONE",
      409,
      "The app's check confirmed nothing happened. Ask the person before trying again.",
    );
  throw new AiCapabilityExecutionError(
    "ACTION_OUTCOME_UNKNOWN",
    409,
    check.state === "pending"
      ? "The app does not know the outcome yet. Do not retry the Action."
      : "The outcome check failed. Do not retry the Action.",
  );
};

/**
 * A rejected approval never reaches the dispatcher, so the assistant records
 * the same execution row the dispatcher would have written for the attempt.
 */
export const recordRejectedAiCapability = async (input: {
  entry: Pick<AiCapabilityCatalogEntry, "appId" | "kind" | "name" | "operation">;
  actor: CapabilityActor;
  args: unknown;
}): Promise<void> => {
  const at = new Date();
  await recordCapabilityExecution({
    requestId: crypto.randomUUID(),
    origin: "assistant",
    appId: input.entry.appId,
    capability: input.entry.name,
    kind: input.entry.kind,
    destructive: "destructive" in input.entry.operation ? input.entry.operation.destructive : false,
    actorKind: "user",
    actorId: input.actor.user.id,
    userId: input.actor.user.id,
    status: "rejected",
    inputMeta: capabilityValueMeta(input.args),
    startedAt: at,
    completedAt: at,
  });
};
