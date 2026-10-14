import type { Context } from "hono";
import { userFromActor } from "../server/actor";
import { type ApiErrorResponse, respond } from "../server/api";
import type { AuthContext, RequestActor } from "../server/middleware/auth";
import { err, fail } from "../server/services";
import type { AiToolApprovalContext } from "./approvals";
import { personalAiModelPolicy } from "./personal-agent";
import type { AiModelPolicy } from "./types";

/** Everything a resolved, authorized request needs to run against the shared runtime. */
export type AiChatRequestContext = {
  actor: RequestActor;
  ownerUserId: string;
  modelPolicy: AiModelPolicy;
  toolApprovalContext: AiToolApprovalContext;
  /** A person in a signed-in browser session, not `cld`, an API key, or another delegated credential. */
  signedInSession: boolean;
};

export const resolveAiChatRequestContext = async <T extends AuthContext>(
  c: Context<T>,
): Promise<AiChatRequestContext | ApiErrorResponse> => {
  const actor = c.get("actor");
  const user = userFromActor(actor);
  if (!user) return respond(c, fail(err.forbidden("AI conversations require a user-backed actor.")));
  return {
    actor,
    ownerUserId: user.id,
    modelPolicy: personalAiModelPolicy,
    toolApprovalContext: { actorUserId: user.id },
    signedInSession: actor.kind === "user" && !actor.delegation && c.get("credentialKind") === "session",
  };
};
