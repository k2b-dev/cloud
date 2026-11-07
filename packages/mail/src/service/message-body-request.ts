import { redis, sql } from "@k2b/cloud";
import { ratelimit } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { messageVisibleTo } from "./access";
import { type MailRequestContext, personalPrincipal } from "./auth";
import { resolveMailExecution } from "./execution";
import { canHydrateMessage, enqueueMessageHydration } from "./sync-runtime";

/**
 * What a request for an opened message's body did:
 * - `loaded`: the body is already stored, so the reader only has to read it again;
 * - `requested`: the body's own job is queued, or was queued moments ago, and takes the next turn
 *   of the mailbox's provider lease after the work holding it, ahead of folder checks;
 * - `limited`: the person asked for many bodies of this mailbox in a short time, so this one loads
 *   in the mailbox's normal order;
 * - `unavailable`: no job can fetch it now, for example because no copy is left in a synced
 *   folder or because the message is too large.
 *
 * `waitedMs` is how long the person has been waiting for this body, counted from the first request
 * on the server, so a reload or a second tab continues the same wait instead of starting a new one.
 */
export type MessageBodyRequest = { state: "loaded" | "requested" | "limited" | "unavailable"; waitedMs: number };

// A person who reads opens a message every few seconds at most. Twelve bodies per minute and
// mailbox cover that pace, while clicking through a long list cannot put more than one job a
// turn ahead of the mailbox's folder checks: commands and other work take turns on the lease.
export const REQUESTS_PER_MINUTE = 12;
// One job per message and window is enough: the job is coalesced, and a second open of the same
// message in the window, by a reload or another reader, joins the wait of the first.
const REQUEST_WINDOW_MS = 10_000;
// The wait a reader shows outlives a reload; after this long, a new open starts a new wait.
const WAIT_MEMORY_MS = 15 * 60_000;

const requestLimiter = ratelimit({ id: "message-body-request", limit: REQUESTS_PER_MINUTE, windowSecs: 60, prefix: "mail:rate-limit" });

const requestKey = (messageId: string) => `mail:message-body-request:${messageId}`;
const waitKey = (messageId: string) => `mail:message-body-wait:${messageId}`;

const waitedMs = async (messageId: string, restart: boolean): Promise<number> => {
  const now = Date.now();
  await redis.send("SET", [waitKey(messageId), String(now), "PX", String(WAIT_MEMORY_MS), ...(restart ? [] : ["NX"])]);
  const since = Number(await redis.send("GET", [waitKey(messageId)]));
  return Number.isFinite(since) ? Math.max(0, now - since) : 0;
};

/**
 * Asks for the body of a message the caller reads, ahead of the mailbox's folder checks. `retry`
 * starts the wait again, for a person who explicitly asks once more. A body whose download
 * failed is tried again from its first attempt, unless it is too large to fetch at all.
 */
export const requestMessageBody = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  retry: boolean;
}): Promise<Result<MessageBodyRequest>> => {
  const access = await resolveMailExecution({
    mailboxId: params.mailboxId,
    operation: "actorRead",
    conversationScoped: true,
    context: params.context,
  });
  if (!access.ok) return access;
  const visibility = access.data.access;
  if (!visibility) return fail(err.forbidden("Access denied"));
  const [message] = await sql<{ hydration_status: string; hydration_error_code: string | null }[]>`
    SELECT mc.hydration_status, mc.hydration_error_code
    FROM mail.message_contents mc
    WHERE mc.id = ${params.messageId}::uuid AND mc.mailbox_id = ${params.mailboxId}::uuid
      AND ${messageVisibleTo(visibility, sql`mc.id`)}
  `;
  if (!message) return fail(err.notFound("Message"));
  if (message.hydration_status === "body" || message.hydration_status === "complete") return ok({ state: "loaded", waitedMs: 0 });
  if (message.hydration_error_code === "MESSAGE_TOO_LARGE") return ok({ state: "unavailable", waitedMs: 0 });

  let restarted = false;
  if (message.hydration_status === "failed") {
    const reset = await sql`
      UPDATE mail.message_contents message
      SET hydration_status = CASE WHEN message.plain_text IS NOT NULL OR message.sanitized_html IS NOT NULL THEN 'body' ELSE 'envelope' END,
        hydration_attempt = 0, hydration_error_code = NULL
      WHERE message.id = ${params.messageId}::uuid AND message.hydration_status = 'failed'
        AND message.hydration_error_code IS DISTINCT FROM 'MESSAGE_TOO_LARGE'
        AND EXISTS (SELECT 1 FROM mail.remote_message_refs live WHERE live.message_id = message.id AND live.stale_at IS NULL)
    `;
    restarted = reset.count > 0;
    if (!restarted) return ok({ state: "unavailable", waitedMs: 0 });
  }
  const waited = await waitedMs(params.messageId, params.retry || restarted);
  if (!(await canHydrateMessage(params.messageId))) return ok({ state: "unavailable", waitedMs: waited });

  // A body tried again after a failure needs its job even if one ran in the window.
  const fresh = await redis.send("SET", [requestKey(params.messageId), "1", "PX", String(REQUEST_WINDOW_MS), ...(restarted ? [] : ["NX"])]);
  if (fresh !== "OK") return ok({ state: "requested", waitedMs: waited });
  const principal = personalPrincipal(params.context);
  const limit = await requestLimiter.check(`${principal.kind}:${principal.id}:${params.mailboxId}`);
  if (limit.limited) {
    await redis.send("DEL", [requestKey(params.messageId)]);
    return ok({ state: "limited", waitedMs: waited });
  }
  try {
    await enqueueMessageHydration(params.messageId);
  } catch (error) {
    // The window must not answer "requested" for a job that was never queued.
    await redis.send("DEL", [requestKey(params.messageId)]);
    throw error;
  }
  return ok({ state: "requested", waitedMs: waited });
};
