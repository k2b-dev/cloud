import { createHash } from "node:crypto";
import type { ToolContext } from "@k2b/nessi";
import { type CapabilityDispatchDependencies, dispatchCapability } from "../api/capabilities";
import { type CapabilityActionManifest, type CapabilityActionReview, CapabilityActionReviewSchema } from "../contracts/capabilities";
import type { RequestActor } from "../server";
import type { AccessSubject } from "../server/services/access";
import { isAccountExpired } from "../services/account-model";
import { accounts } from "../services/accounts";
import { session } from "../services/session";
import { LOCALE_HEADER } from "../shared/locale";
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
  dependencies?: CapabilityDispatchDependencies & {
    createDelegation?: (userId: string, ttlSeconds?: number) => Promise<string>;
    revokeDelegation?: (token: string) => Promise<void>;
    dispatch?: typeof dispatchCapability;
  };
};

const dispatchAiCapability = async (input: AiCapabilityCall, review: boolean): Promise<unknown> => {
  if (input.authority.accessSubject.type !== "user" || input.authority.accessSubject.userId !== input.authority.actor.user.id) {
    throw new Error("Cloud capability authority is inconsistent.");
  }
  const createDelegation = input.dependencies?.createDelegation ?? session.createDelegation;
  const revokeDelegation = input.dependencies?.revokeDelegation ?? session.revoke;
  const dispatch = input.dependencies?.dispatch ?? dispatchCapability;
  const token = await createDelegation(input.authority.actor.user.id, 60);
  try {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (input.locale) headers.set(LOCALE_HEADER, input.locale);
    const action = input.entry.kind === "action" ? (input.entry.operation as CapabilityActionManifest) : null;
    if (!review && action?.idempotency === "required" && input.context.callId) {
      const key = idempotencyKey(input.conversationId, input.context.callId);
      if (input.turnId) {
        await aiToolAudit.noteCapabilityDispatch({
          conversationId: input.conversationId,
          turnId: input.turnId,
          callId: input.context.callId,
          toolName: input.entry.name,
          idempotencyKey: key,
        });
      }
      headers.set("idempotency-key", key);
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
        review,
        appId: input.entry.appId,
        capabilityId: input.entry.operation.localId,
        input: input.args,
        dependencies: input.dependencies,
      }),
    );
  } finally {
    await revokeDelegation(token).catch(() => undefined);
  }
};

export const reviewAiCapability = async (input: AiCapabilityCall): Promise<CapabilityActionReview | null> => {
  if (input.entry.kind !== "action" || !(input.entry.operation as CapabilityActionManifest).review) return null;
  return CapabilityActionReviewSchema.parse(await dispatchAiCapability(input, true));
};

export const executeAiCapability = (input: AiCapabilityCall): Promise<unknown> => dispatchAiCapability(input, false);
