import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit } from "@k2b/cloud/services";
import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import { sql } from "bun";
import type { RemoteContentRuleInput, RemoteContentRuleScope } from "../contracts";
import { normalizeEmailAddress, normalizeEmailDomain } from "./address-normalization";
import { auditActorFromRequest, type MailRequestContext, userBackedActor } from "./auth";
import { createPinnedLookup, resolvePublicEndpoint } from "./connectors/endpoint-policy";
import { resolveMailExecution } from "./execution";

const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_REMOTE_CONTENT_RULES = 500;
const ALLOWED_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

type PersonalPrincipal = {
  kind: "user" | "service_account";
  id: string;
};

type RemoteImageRow = {
  id: string;
  message_id: string;
};

type StoredRemoteImage = {
  source_url: string;
};

type RemoteContentRuleRow = {
  id: string;
  mailbox_id: string;
  scope: RemoteContentRuleScope;
  value: string;
  created_at: Date | string;
};

export type RemoteContentRule = {
  id: string;
  mailboxId: string;
  scope: RemoteContentRuleScope;
  value: string;
  createdAt: string;
};

export type MessageRemoteContent = {
  imageIds: string[];
  allowedByRule: boolean;
  sender: string | null;
  domain: string | null;
};

export type RemoteImagePayload = {
  bytes: Uint8Array;
  contentType: string;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const mapRule = (row: RemoteContentRuleRow): RemoteContentRule => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  scope: row.scope,
  value: row.value,
  createdAt: toIso(row.created_at),
});

const personalPrincipal = (context: MailRequestContext): PersonalPrincipal => {
  const user = userBackedActor(context);
  if (user) return { kind: "user", id: user.id };
  if (context.actor.kind === "service_account") {
    return { kind: "service_account", id: context.actor.serviceAccount.id };
  }
  throw new Error("Mail request actor has no personal principal");
};

export const normalizeRemoteContentRule = (input: RemoteContentRuleInput): Result<{ scope: RemoteContentRuleScope; value: string }> => {
  const value = input.scope === "sender" ? normalizeEmailAddress(input.value) : normalizeEmailDomain(input.value);
  return value ? ok({ scope: input.scope, value }) : fail(err.badInput(`Invalid remote-content ${input.scope}`));
};

const listRulesForPrincipal = async (mailboxId: string, principal: PersonalPrincipal): Promise<RemoteContentRuleRow[]> =>
  sql<RemoteContentRuleRow[]>`
    SELECT id, mailbox_id, scope, value, created_at
    FROM mail.remote_content_rules
    WHERE mailbox_id = ${mailboxId}::uuid
      AND actor_kind = ${principal.kind}
      AND actor_id = ${principal.id}::uuid
    ORDER BY scope, value, id
  `;

export const listRemoteContentRules = async (context: MailRequestContext, mailboxId: string): Promise<Result<RemoteContentRule[]>> => {
  const access = await resolveMailExecution({ mailboxId, operation: "actorRead", context });
  if (!access.ok) return access;
  return ok((await listRulesForPrincipal(mailboxId, personalPrincipal(context))).map(mapRule));
};

export const createRemoteContentRule = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: RemoteContentRuleInput;
}): Promise<Result<RemoteContentRule>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const normalized = normalizeRemoteContentRule(params.input);
  if (!normalized.ok) return normalized;
  const principal = personalPrincipal(params.context);
  const result = await sql.begin(async (tx): Promise<Result<RemoteContentRuleRow>> => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`mail.remote-content-rules:${params.mailboxId}:${principal.kind}:${principal.id}`}, 0)
      )
    `;
    const [existing] = await tx<RemoteContentRuleRow[]>`
      SELECT id, mailbox_id, scope, value, created_at
      FROM mail.remote_content_rules
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND actor_kind = ${principal.kind}
        AND actor_id = ${principal.id}::uuid
        AND scope = ${normalized.data.scope}
        AND value = ${normalized.data.value}
    `;
    if (existing) return ok(existing);
    const [usage] = await tx<{ count: string | number }[]>`
      SELECT count(*) AS count
      FROM mail.remote_content_rules
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND actor_kind = ${principal.kind}
        AND actor_id = ${principal.id}::uuid
    `;
    if (Number(usage?.count ?? 0) >= MAX_REMOTE_CONTENT_RULES) {
      return fail(err.badInput(`At most ${MAX_REMOTE_CONTENT_RULES} remote-content rules may be stored per mailbox`));
    }
    const [inserted] = await tx<RemoteContentRuleRow[]>`
      INSERT INTO mail.remote_content_rules (mailbox_id, actor_kind, actor_id, scope, value)
      VALUES (
        ${params.mailboxId}::uuid,
        ${principal.kind},
        ${principal.id}::uuid,
        ${normalized.data.scope},
        ${normalized.data.value}
      )
      ON CONFLICT (mailbox_id, actor_kind, actor_id, scope, value) DO NOTHING
      RETURNING id, mailbox_id, scope, value, created_at
    `;
    if (!inserted) throw new Error("Remote-content rule insert returned no row");
    await audit.record(
      {
        action: "mail.remote_content_rule.create",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "remote_content_rule", id: inserted.id, label: inserted.value },
        requestId: params.context.requestId,
        metadata: { mailboxId: params.mailboxId, scope: inserted.scope },
      },
      tx,
    );
    return ok(inserted);
  });
  return result.ok ? ok(mapRule(result.data)) : result;
};

export const deleteRemoteContentRule = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  ruleId: string;
}): Promise<Result<{ id: string }>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const principal = personalPrincipal(params.context);
  return sql.begin(async (tx): Promise<Result<{ id: string }>> => {
    const [deleted] = await tx<RemoteContentRuleRow[]>`
      DELETE FROM mail.remote_content_rules
      WHERE id = ${params.ruleId}::uuid
        AND mailbox_id = ${params.mailboxId}::uuid
        AND actor_kind = ${principal.kind}
        AND actor_id = ${principal.id}::uuid
      RETURNING id, mailbox_id, scope, value, created_at
    `;
    if (!deleted) return fail(err.notFound("Remote-content rule"));
    await audit.record(
      {
        action: "mail.remote_content_rule.delete",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "remote_content_rule", id: deleted.id, label: deleted.value },
        requestId: params.context.requestId,
        metadata: { mailboxId: params.mailboxId, scope: deleted.scope },
      },
      tx,
    );
    return ok({ id: deleted.id });
  });
};

const senderDomain = (sender: string): string | null => sender.slice(sender.lastIndexOf("@") + 1) || null;

export const resolveMessagesRemoteContent = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messages: Array<{ id: string; from: Array<{ address: string }> }>;
}): Promise<Result<Map<string, MessageRemoteContent>>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const result = new Map<string, MessageRemoteContent>();
  if (params.messages.length === 0) return ok(result);
  const messageIds = params.messages.map((message) => message.id);
  const images = await sql<RemoteImageRow[]>`
    SELECT image.id, image.message_id
    FROM mail.message_remote_images image
    JOIN mail.message_contents content ON content.id = image.message_id
    WHERE content.mailbox_id = ${params.mailboxId}::uuid
      AND image.message_id = ANY(${toPgUuidArray(messageIds)}::uuid[])
    ORDER BY image.message_id, image.position
  `;
  const imagesByMessage = new Map<string, string[]>();
  for (const image of images) {
    const current = imagesByMessage.get(image.message_id) ?? [];
    current.push(image.id);
    imagesByMessage.set(image.message_id, current);
  }
  const rules = await listRulesForPrincipal(params.mailboxId, personalPrincipal(params.context));
  const senders = new Set(rules.filter((rule) => rule.scope === "sender").map((rule) => rule.value));
  const domains = new Set(rules.filter((rule) => rule.scope === "domain").map((rule) => rule.value));
  for (const message of params.messages) {
    const normalizedSenders = [
      ...new Set(message.from.map((address) => normalizeEmailAddress(address.address)).filter((value) => value !== null)),
    ];
    const allowedByRule =
      normalizedSenders.length > 0 && normalizedSenders.every((sender) => senders.has(sender) || domains.has(senderDomain(sender) ?? ""));
    const sender = normalizedSenders.length === 1 ? normalizedSenders[0]! : null;
    result.set(message.id, {
      imageIds: imagesByMessage.get(message.id) ?? [],
      allowedByRule,
      sender,
      domain: sender ? senderDomain(sender) : null,
    });
  }
  return ok(result);
};

const remoteImageSource = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  imageId: string;
}): Promise<Result<string>> => {
  const access = await resolveMailExecution({ mailboxId: params.mailboxId, operation: "actorRead", context: params.context });
  if (!access.ok) return access;
  const [image] = await sql<StoredRemoteImage[]>`
    SELECT image.source_url
    FROM mail.message_remote_images image
    JOIN mail.message_contents content ON content.id = image.message_id
    WHERE image.id = ${params.imageId}::uuid
      AND image.message_id = ${params.messageId}::uuid
      AND content.mailbox_id = ${params.mailboxId}::uuid
  `;
  return image ? ok(image.source_url) : fail(err.notFound("Remote image"));
};

const imageContentType = (value: string | undefined): string | null => {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_IMAGE_TYPES.has(type) ? type : null;
};

export const matchesRemoteImageSignature = (contentType: string, bytes: Uint8Array): boolean => {
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png")
    return (
      bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
    );
  if (contentType === "image/gif")
    return (
      bytes.length >= 6 &&
      (new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a")
    );
  if (contentType === "image/webp")
    return (
      bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
    );
  if (contentType === "image/avif")
    return (
      bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp" &&
      /^avi[fs]$/u.test(new TextDecoder().decode(bytes.slice(8, 12)))
    );
  return false;
};

const requestRemoteImage = async (
  url: URL,
  deadline = Date.now() + REMOTE_IMAGE_TIMEOUT_MS,
  redirectCount = 0,
): Promise<RemoteImagePayload> => {
  const secure = url.protocol === "https:";
  if ((!secure && url.protocol !== "http:") || url.username || url.password) throw new Error("Remote image URL is not allowed");
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Remote image request timed out");
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const endpoint = await resolvePublicEndpoint(
    {
      host: url.hostname,
      port,
      tlsMode: secure ? "implicit" : "starttls",
    },
    Math.min(5_000, remainingMs),
  );
  return new Promise<RemoteImagePayload>((resolve, reject) => {
    let settled = false;
    let totalTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (totalTimeout) clearTimeout(totalTimeout);
      callback();
    };
    const request = (secure ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: endpoint.host,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: createPinnedLookup(endpoint),
        servername: secure ? endpoint.host : undefined,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
          "Accept-Encoding": "identity",
          "User-Agent": "Cloud-Mail-Remote-Image/1.0",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS || !response.headers.location) {
            finish(() => reject(new Error("Remote image redirected too many times")));
            return;
          }
          let target: URL;
          try {
            target = new URL(response.headers.location, url);
          } catch {
            finish(() => reject(new Error("Remote image redirect is invalid")));
            return;
          }
          finish(() => {
            void requestRemoteImage(target, deadline, redirectCount + 1).then(resolve, reject);
          });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(() => reject(new Error("Remote image request failed")));
          return;
        }
        const contentType = imageContentType(response.headers["content-type"]);
        const rawLength = response.headers["content-length"];
        const declaredLength = rawLength === undefined ? null : Number(rawLength);
        if (
          !contentType ||
          (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") ||
          (declaredLength !== null &&
            (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_REMOTE_IMAGE_BYTES))
        ) {
          response.destroy();
          finish(() => reject(new Error("Remote image response is not allowed")));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          total += chunk.byteLength;
          if (total > MAX_REMOTE_IMAGE_BYTES) {
            response.destroy(new Error("Remote image is too large"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", (error) => finish(() => reject(error)));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks, total);
          if (!matchesRemoteImageSignature(contentType, bytes)) {
            finish(() => reject(new Error("Remote image content does not match its type")));
            return;
          }
          finish(() => resolve({ bytes, contentType }));
        });
      },
    );
    request.on("error", (error) => finish(() => reject(error)));
    request.setTimeout(remainingMs, () => request.destroy(new Error("Remote image request timed out")));
    totalTimeout = setTimeout(() => request.destroy(new Error("Remote image request timed out")), remainingMs);
    request.end();
  });
};

export const loadRemoteImage = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  imageId: string;
}): Promise<Result<RemoteImagePayload>> => {
  const source = await remoteImageSource(params);
  if (!source.ok) return source;
  try {
    const image = await requestRemoteImage(new URL(source.data));
    const currentSource = await remoteImageSource(params);
    if (!currentSource.ok) return currentSource;
    if (currentSource.data !== source.data) return fail(err.notFound("Remote image"));
    return ok(image);
  } catch {
    return fail(err.badInput("This remote image could not be loaded safely"));
  }
};
