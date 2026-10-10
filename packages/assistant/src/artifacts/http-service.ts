import { createHash } from "node:crypto";
import {
  AI_WEBSITE_APPROVAL_TOOL,
  aiConversations,
  aiProjects,
  aiWebsiteApprovalScope,
  findRememberedAiToolApproval,
  rememberAiToolApproval,
} from "@k2b/cloud/ai";
import { requestPublicHttps, secrets } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { LIMITS } from "./contracts";
import {
  HeaderValue,
  HTTP_BYTES,
  HTTP_CALL_TTL_MS,
  HTTP_TIMEOUT_MS,
  HttpPrepare,
  HttpRequest,
  HttpReview,
  HttpScope,
  SecretName,
  SecretSave,
  SecretView,
} from "./http-contracts";
import { redactSecrets } from "./http-redaction";
import { CloudError } from "./runtime/errors";
import { type ArtifactIdentity, artifacts, user } from "./service";

export class HttpError extends Error {
  constructor(readonly code: "HTTP_DENIED" | "HTTP_CONFLICT" | "HTTP_LIMIT" | "HTTP_UNKNOWN" | "HTTP_SECRET" | "HTTP_FAILED") {
    super(code);
  }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function context(input: HttpScope, identity: ArtifactIdentity) {
  const scope = HttpScope.parse(input),
    actor = user(identity);
  let conversationId: string | null = null;
  if (scope.conversationId) {
    const conversation = z.uuid().safeParse(scope.conversationId).success
      ? await aiConversations.getConversation({ conversationId: scope.conversationId, ownerUserId: actor.id })
      : await aiConversations.getConversationByShortId({ shortId: scope.conversationId, ownerUserId: actor.id });
    if (!conversation || conversation.archivedAt || (conversation.allowedTools !== null && conversation.allowedTools !== undefined))
      throw new HttpError("HTTP_DENIED");
    if (conversation.projectId && !(await aiProjects.get(conversation.projectId, identity.accessSubject, "read")))
      throw new HttpError("HTTP_DENIED");
    conversationId = conversation.id;
  }
  const resource = scope.resourceId
    ? await artifacts.get(scope.resourceId, { ...identity, conversationId: conversationId ?? undefined })
    : undefined;
  return { userId: actor.id, key: resource ? `resource:${resource.id}` : `chat:${conversationId}`, resource, conversationId };
}

type SecretRow = { name: string; origin: string; header: string; prefix: string; encrypted: string; revision: string };
async function rows(userId: string, scope: string) {
  return sql<
    SecretRow[]
  >`SELECT name,origin,header,prefix,encrypted,revision FROM assistant.http_secrets WHERE user_id=${userId}::uuid AND scope=${scope} ORDER BY name`;
}

async function bindings(request: HttpRequest, scope: HttpScope, identity: ArtifactIdentity) {
  const ctx = await context(scope, identity),
    available = await rows(ctx.userId, ctx.key);
  const used: Record<string, string> = {};
  for (const [header, value] of Object.entries(request.headers)) {
    if (typeof value === "string") continue;
    const row = available.find((row) => row.name === value.secret);
    if (!row || row.origin !== new URL(request.url).origin || row.header !== header || row.prefix !== value.prefix)
      throw new HttpError("HTTP_SECRET");
    used[row.name] = row.revision;
  }
  return { ctx, available, used };
}

const StoredCall = z.object({
  id: z.uuid(),
  createdAt: z.number(),
  scope: HttpScope,
  request: HttpRequest,
  used: z.record(z.string(), z.string()),
});
async function pendingCall(id: string, userId: string) {
  const [row] = await sql<
    { encrypted: string; status: string }[]
  >`SELECT encrypted,status FROM assistant.http_calls WHERE id=${z.uuid().parse(id)}::uuid AND user_id=${userId}::uuid AND created_at > now() - interval '1 day'`;
  if (!row || row.status !== "pending") throw new HttpError("HTTP_UNKNOWN");
  return StoredCall.parse(await secrets.decrypt(row.encrypted));
}

/** What a website approval may cover: a request that only reads one exact origin. */
export type HttpWebsiteRead = {
  origin: string;
  method: "GET" | "HEAD";
  url: string;
  conversationId: string | null;
  /** The Studio app the request runs for, which the person manages. */
  resourceId: string | null;
};

export const httpService = {
  /**
   * Derives the website a stored, still pending request reads, from the request itself and never from its caller:
   * only GET or HEAD without a body and without any header (so without a secret) qualifies, and only from a chat or
   * from a Studio app the person manages. Returns null for every other request; such a request always asks.
   */
  async website(id: string, identity: ArtifactIdentity): Promise<HttpWebsiteRead | null> {
    const stored = await pendingCall(id, user(identity).id);
    const { method, body, headers, url } = stored.request;
    if ((method !== "GET" && method !== "HEAD") || body !== undefined || Object.keys(headers).length > 0) return null;
    const ctx = await context(stored.scope, identity);
    if (ctx.resource && ctx.resource.permission !== "admin") return null;
    return { origin: new URL(url).origin, method, url, conversationId: ctx.conversationId, resourceId: ctx.resource?.id ?? null };
  },
  /**
   * The website approval of a Studio app the person manages, for one pending request: whether its card may offer
   * "allow this website for this app", whether a remembered approval already allows it, and with `remember`, records
   * that approval first. A request from a chat or from an app the person does not manage gets neither.
   */
  async appWebsite(id: string, remember: boolean, identity: ArtifactIdentity) {
    const website = await this.website(id, identity);
    if (!website?.resourceId) {
      if (remember) throw new HttpError("HTTP_DENIED");
      return { offer: false, allowed: false, approvalId: null };
    }
    const context = { actorUserId: user(identity).id };
    const approval = { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: aiWebsiteApprovalScope(website.origin, website.resourceId) };
    if (remember) await rememberAiToolApproval(context, approval);
    const approvalId = await findRememberedAiToolApproval(context, approval);
    return { offer: true, allowed: approvalId !== null, approvalId };
  },
  async cleanup() {
    await sql`UPDATE assistant.http_calls SET status='expired',encrypted='' WHERE status='pending' AND created_at < now() - interval '1 day'`;
    await sql`DELETE FROM assistant.http_calls WHERE created_at < now() - interval '2 days'`;
  },
  async list(scope: HttpScope, identity: ArtifactIdentity) {
    const ctx = await context(scope, identity);
    return (await rows(ctx.userId, ctx.key)).map((row) => SecretView.parse({ ...row, configured: true }));
  },
  async save(scope: HttpScope, input: z.infer<typeof SecretSave>, identity: ArtifactIdentity) {
    const value = SecretSave.parse(input),
      ctx = await context(scope, identity);
    const encrypted = await secrets.encrypt(value.value);
    return sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(hashtext(${ctx.userId + ctx.key}))`;
      const [current] = await db<
        { revision: string }[]
      >`SELECT revision FROM assistant.http_secrets WHERE user_id=${ctx.userId}::uuid AND scope=${ctx.key} AND name=${value.name}`;
      if ((current?.revision ?? null) !== value.expectedRevision) throw new HttpError("HTTP_CONFLICT");
      const [count] = await db<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM assistant.http_secrets WHERE user_id=${ctx.userId}::uuid AND scope=${ctx.key}`;
      if (!current && count!.count >= LIMITS.files) throw new HttpError("HTTP_LIMIT");
      const revision = crypto.randomUUID();
      await db`INSERT INTO assistant.http_secrets(user_id,scope,name,resource_id,origin,header,prefix,encrypted,revision)
        VALUES(${ctx.userId}::uuid,${ctx.key},${value.name},(SELECT id FROM assistant.artifacts WHERE short_id=${ctx.resource?.id ?? null}),${value.origin},${value.header},${value.prefix},${encrypted},${revision}::uuid)
        ON CONFLICT(user_id,scope,name) DO UPDATE SET origin=EXCLUDED.origin,header=EXCLUDED.header,prefix=EXCLUDED.prefix,encrypted=EXCLUDED.encrypted,revision=EXCLUDED.revision`;
      return SecretView.parse({ ...value, revision, configured: true });
    });
  },
  async remove(scope: HttpScope, name: string, revision: string, identity: ArtifactIdentity) {
    const ctx = await context(scope, identity);
    const removed =
      await sql`DELETE FROM assistant.http_secrets WHERE user_id=${ctx.userId}::uuid AND scope=${ctx.key} AND name=${SecretName.parse(name)} AND revision=${z.uuid().parse(revision)}::uuid RETURNING name`;
    if (!removed.length) throw new HttpError("HTTP_CONFLICT");
    return { deleted: true };
  },
  async prepare(input: HttpPrepare, identity: ArtifactIdentity) {
    const call = HttpPrepare.parse(input);
    if (Math.abs(Date.now() - call.createdAt) > HTTP_CALL_TTL_MS) throw new HttpError("HTTP_CONFLICT");
    const { ctx, used } = await bindings(call.request, call.scope, identity);
    const bytes = Buffer.from(call.request.body ?? "", "base64");
    if (bytes.byteLength > HTTP_BYTES) throw new HttpError("HTTP_LIMIT");
    const hash = digest(call),
      encrypted = await secrets.encrypt({ ...call, used });
    const review = HttpReview.parse({
      id: call.id,
      url: call.request.url,
      method: call.request.method,
      headers: call.request.headers,
      bodyBytes: bytes.length,
      bodyPreview: bytes.toString("utf8").slice(0, LIMITS.text),
      bodyTruncated: bytes.length > LIMITS.text,
      resourceTitle: ctx.resource?.title,
    });
    await sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(hashtext(${ctx.userId + ":http"}))`;
      // The request timestamp prevents replay after bounded claim retention.
      await db`DELETE FROM assistant.http_calls WHERE user_id=${ctx.userId}::uuid AND created_at < now() - interval '2 days'`;
      const [existing] = await db<
        { hash: string; status: string }[]
      >`SELECT hash,status FROM assistant.http_calls WHERE user_id=${ctx.userId}::uuid AND id=${call.id}::uuid`;
      if (existing) {
        if (existing.hash !== hash || existing.status !== "pending") throw new HttpError("HTTP_UNKNOWN");
        return;
      }
      const [active] = await db<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM assistant.http_calls WHERE user_id=${ctx.userId}::uuid AND status IN ('pending','running') AND created_at > now() - interval '1 day'`;
      if (active!.count >= LIMITS.pendingRequests) throw new HttpError("HTTP_LIMIT");
      await db`INSERT INTO assistant.http_calls(id,user_id,hash,encrypted) VALUES(${call.id}::uuid,${ctx.userId}::uuid,${hash},${encrypted})`;
    });
    return review;
  },
  async execute(
    id: string,
    approved: boolean,
    identity: ArtifactIdentity,
    signal: AbortSignal,
    send = requestPublicHttps,
    authorize?: (request: HttpPrepare) => Promise<void>,
  ) {
    const userId = user(identity).id;
    const stored = await pendingCall(id, userId);
    if (!approved) {
      await sql`UPDATE assistant.http_calls SET status='denied',encrypted='' WHERE id=${id}::uuid AND user_id=${userId}::uuid AND status='pending'`;
      throw new HttpError("HTTP_DENIED");
    }
    await authorize?.(stored);
    const { available, used } = await bindings(stored.request, stored.scope, identity);
    if (digest(used) !== digest(stored.used)) throw new HttpError("HTTP_CONFLICT");
    const headers: Record<string, string> = {};
    const inserted: { value: string; sent: string }[] = [];
    try {
      for (const [name, value] of Object.entries(stored.request.headers)) {
        if (typeof value === "string") headers[name] = value;
        else {
          const secret = HeaderValue.parse(await secrets.decrypt(available.find((row) => row.name === value.secret)!.encrypted));
          headers[name] = value.prefix + secret;
          inserted.push({ value: secret, sent: headers[name] });
        }
      }
    } catch {
      throw new HttpError("HTTP_SECRET");
    }
    if (Buffer.byteLength(JSON.stringify(headers)) > LIMITS.text) throw new HttpError("HTTP_LIMIT");
    signal.throwIfAborted();
    const claimed =
      await sql`UPDATE assistant.http_calls SET status='running',encrypted='' WHERE id=${id}::uuid AND user_id=${userId}::uuid AND status='pending' RETURNING id`;
    if (!claimed.length) throw new HttpError("HTTP_UNKNOWN");
    try {
      const response = await send({
        url: stored.request.url,
        method: stored.request.method,
        headers,
        body: stored.request.body === undefined ? undefined : Buffer.from(stored.request.body, "base64"),
        maxBytes: HTTP_BYTES,
        signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
      });
      await sql`UPDATE assistant.http_calls SET status='completed' WHERE id=${id}::uuid AND user_id=${userId}::uuid`;
      const redacted = redactSecrets(response, inserted);
      if (redacted.body.length > HTTP_BYTES) throw new HttpError("HTTP_LIMIT");
      return { status: response.status, headers: redacted.headers, body: Buffer.from(redacted.body).toString("base64") };
    } catch (error) {
      await sql`UPDATE assistant.http_calls SET status='unknown' WHERE id=${id}::uuid AND user_id=${userId}::uuid`.catch(() => {});
      if (error instanceof HttpError || error instanceof CloudError) throw error;
      if (signal.aborted) throw signal.reason;
      throw new HttpError("HTTP_UNKNOWN");
    }
  },
};
