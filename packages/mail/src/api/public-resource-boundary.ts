import { err, fail, type Result, type ServiceError } from "@k2b/stdlib";
import { type ApiErrorResponse, type AuthContext, getLocale, respond } from "@valentinkolb/cloud/server";
import type { Context, Next, TypedResponse } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { publicResources } from "../service";
import { localizeMailError } from "../service/error-messages";

export type MailApiContext = AuthContext & {
  Variables: AuthContext["Variables"] & Partial<Record<InternalVariable, string>>;
};

export const mailboxParamSchema = z.object({ mailboxId: ResourceShortIdSchema });
export const mailboxResourceParamSchema = (name: string) => z.object({ mailboxId: ResourceShortIdSchema, [name]: ResourceShortIdSchema });

const resolvedParamVariables = {
  mailboxId: "internalMailboxId",
  folderId: "internalFolderId",
  conversationId: "internalConversationId",
  messageId: "internalMessageId",
  attachmentId: "internalAttachmentId",
  draftId: "internalDraftId",
  senderIdentityId: "internalSenderIdentityId",
  tagId: "internalTagId",
  commentId: "internalCommentId",
  sourceId: "internalReminderId",
  viewId: "internalViewId",
  templateId: "internalTemplateId",
  scheduledSendId: "internalScheduledSendId",
  automationId: "internalAutomationId",
  configurationId: "internalAutomaticReplyId",
} as const;

type InternalVariable = (typeof resolvedParamVariables)[keyof typeof resolvedParamVariables];
type PublicParam = keyof typeof resolvedParamVariables;

type RelationTable = publicResources.MailPublicResourceTable;
const INTERNAL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const relationTables: Record<string, RelationTable> = {
  mailboxId: "mailboxes",
  folderId: "folders",
  sourceFolderId: "folders",
  destinationFolderId: "folders",
  parentFolderId: "folders",
  activeFolderIds: "folders",
  unreadFolderIds: "folders",
  sentFolderId: "folders",
  draftsFolderId: "folders",
  conversationId: "conversations",
  sourceConversationId: "conversations",
  targetConversationId: "conversations",
  conversationIds: "conversations",
  lastConversationId: "conversations",
  sourceMessageId: "messages",
  outboundMessageId: "messages",
  derivedFromMessageId: "messages",
  referencedMessageId: "messages",
  messageIds: "messages",
  lastMessageId: "messages",
  draftId: "drafts",
  senderIdentityId: "senderIdentities",
  tagId: "tags",
  tagIds: "tags",
  commentId: "comments",
  reminderId: "reminders",
  viewId: "savedViews",
  templateId: "composeTemplates",
  defaultSignatureTemplateId: "composeTemplates",
  automationId: "incomingAutomations",
  configurationId: "automaticReplyConfigurations",
  scheduledSendId: "deliveries",
  outboxSubmissionId: "deliveries",
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isSourceId = (direction: "internal" | "public", value: string): boolean =>
  direction === "public" ? INTERNAL_UUID_REGEX.test(value) : ResourceShortIdSchema.safeParse(value).success;

const replaceId = (
  table: RelationTable,
  id: unknown,
  ids: Map<RelationTable, Map<string, string>>,
  direction: "internal" | "public",
): unknown => {
  if (typeof id !== "string" || !isSourceId(direction, id)) return id;
  const replacement = ids.get(table)?.get(id);
  if (!replacement) throw new Error(`Missing ${table} public ID for ${id}`);
  return replacement;
};

const collectRelations = (value: unknown, collected: Map<RelationTable, string[]>, direction: "internal" | "public"): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectRelations(item, collected, direction);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const table = relationTables[key];
    if (table) {
      const values = Array.isArray(child) ? child : [child];
      for (const id of values) {
        if (typeof id === "string" && isSourceId(direction, id)) {
          collected.set(table, [...(collected.get(table) ?? []), id]);
        }
      }
    }
    collectRelations(child, collected, direction);
  }
};

const replaceRelations = (value: unknown, ids: Map<RelationTable, Map<string, string>>, direction: "internal" | "public"): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceRelations(item, ids, direction));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const table = relationTables[key];
      if (!table) return [key, replaceRelations(child, ids, direction)];
      return [
        key,
        Array.isArray(child) ? child.map((id) => replaceId(table, id, ids, direction)) : replaceId(table, child, ids, direction),
      ];
    }),
  );
};

const relationMaps = async (
  value: unknown,
  direction: "internal" | "public",
  mailboxId?: string,
): Promise<Map<RelationTable, Map<string, string>> | null> => {
  const collected = new Map<RelationTable, string[]>();
  collectRelations(value, collected, direction);
  const entries = await Promise.all(
    [...collected].map(async ([table, values]): Promise<readonly [RelationTable, Map<string, string>] | null> => {
      const unique = [...new Set(values)];
      if (direction === "public") return [table, await publicResources.publicIds(table, unique)] as const;
      const resolved =
        table === "mailboxes"
          ? await publicResources.resolvePublicIds(table, unique)
          : mailboxId
            ? await publicResources.resolveMailboxPublicIds(table, mailboxId, unique)
            : null;
      return resolved ? ([table, new Map(unique.map((id, index) => [id, resolved[index]!]))] as const) : null;
    }),
  );
  return entries.some((entry) => entry === null)
    ? null
    : new Map(entries.filter((entry): entry is readonly [RelationTable, Map<string, string>] => entry !== null));
};

export const resolvePublicRelations = async <T>(mailboxId: string, value: T): Promise<T | null> => {
  const maps = await relationMaps(value, "internal", mailboxId);
  return maps ? (replaceRelations(value, maps, "internal") as T) : null;
};

export const internalInput = async <T>(c: Context<MailApiContext>, value: T): Promise<T> => {
  const resolved = await resolvePublicRelations(internalMailboxId(c), value);
  if (!resolved) throw new HTTPException(404, { message: localizeMailError(err.notFound("Mail resource"), getLocale(c)).message });
  return resolved;
};

export const projectPublicRelations = async <T>(value: T): Promise<T> => {
  const maps = await relationMaps(value, "public");
  return replaceRelations(value, maps ?? new Map(), "public") as T;
};

const projectRootIds = async (table: RelationTable, value: unknown): Promise<unknown> => {
  const directItems = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : isRecord(value)
        ? [value]
        : [];
  const resources = directItems.filter(
    (item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string" && INTERNAL_UUID_REGEX.test(item.id),
  );
  const ids = await publicResources.publicIds(
    table,
    resources.map((item) => item.id as string),
  );
  const projected = new Map(resources.map((item) => [item, { ...item, id: publicResources.requirePublicId(ids, item.id as string) }]));
  const replaceRoot = (item: unknown) => projected.get(item as Record<string, unknown>) ?? item;
  const withRootIds = Array.isArray(value)
    ? value.map(replaceRoot)
    : isRecord(value) && Array.isArray(value.items)
      ? { ...value, items: value.items.map(replaceRoot) }
      : isRecord(value)
        ? replaceRoot(value)
        : value;
  if (table !== "drafts" && table !== "messages") return withRootIds;
  const nestedTable = table === "drafts" ? "draftAttachments" : "attachments";
  const nested: Record<string, unknown>[] = [];
  collectNestedAttachments(withRootIds, nested);
  const nestedIds = await publicResources.publicIds(
    nestedTable,
    nested.map((attachment) => attachment.id as string),
  );
  return replaceNestedAttachments(withRootIds, nestedIds);
};

const collectNestedAttachments = (value: unknown, attachments: Record<string, unknown>[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedAttachments(item, attachments);
    return;
  }
  if (!isRecord(value)) return;
  if (Array.isArray(value.attachments)) {
    for (const attachment of value.attachments) {
      if (isRecord(attachment) && typeof attachment.id === "string" && INTERNAL_UUID_REGEX.test(attachment.id))
        attachments.push(attachment);
    }
  }
  for (const child of Object.values(value)) collectNestedAttachments(child, attachments);
};

const replaceNestedAttachments = (value: unknown, ids: Map<string, string>): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceNestedAttachments(item, ids));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "attachments" && Array.isArray(child)
        ? child.map((attachment) =>
            isRecord(attachment) && typeof attachment.id === "string" && INTERNAL_UUID_REGEX.test(attachment.id)
              ? { ...attachment, id: publicResources.requirePublicId(ids, attachment.id) }
              : attachment,
          )
        : replaceNestedAttachments(child, ids),
    ]),
  );
};

export const projectPublicResult = async <T>(result: Result<T>, rootTable?: RelationTable): Promise<Result<T>> => {
  if (!result.ok) return result;
  const withRootIds = rootTable ? await projectRootIds(rootTable, result.data) : result.data;
  return { ok: true, data: (await projectPublicRelations(withRootIds)) as T };
};

export const projectRootRelation = async <T>(result: Result<T>, field: string, table: RelationTable): Promise<Result<T>> => {
  if (!result.ok) return result;
  const rootItems = Array.isArray(result.data)
    ? result.data
    : isRecord(result.data) && Array.isArray(result.data.items)
      ? result.data.items
      : [result.data];
  const ids = rootItems
    .filter(isRecord)
    .map((item) => item[field])
    .filter((id): id is string => typeof id === "string" && INTERNAL_UUID_REGEX.test(id));
  const publicIds = await publicResources.publicIds(table, ids);
  const replace = (item: unknown): unknown => {
    if (!isRecord(item) || typeof item[field] !== "string" || !INTERNAL_UUID_REGEX.test(item[field])) return item;
    return { ...item, [field]: publicResources.requirePublicId(publicIds, item[field]) };
  };
  const data = Array.isArray(result.data)
    ? result.data.map(replace)
    : isRecord(result.data) && Array.isArray(result.data.items)
      ? { ...result.data, items: result.data.items.map(replace) }
      : replace(result.data);
  return { ok: true, data: data as T };
};

export const projectResourcePaths = async <T>(
  result: Result<T>,
  paths: ReadonlyArray<{ path: readonly string[]; table: RelationTable }>,
): Promise<Result<T>> => {
  if (!result.ok) return result;
  const values = paths.map(({ path }) => {
    let value: unknown = result.data;
    for (const segment of path) {
      value = Array.isArray(value) ? value[Number(segment)] : isRecord(value) ? value[segment] : undefined;
    }
    return typeof value === "string" && INTERNAL_UUID_REGEX.test(value) ? value : null;
  });
  const tables = [...new Set(paths.map(({ table }) => table))];
  const maps = new Map(
    await Promise.all(
      tables.map(async (table) => {
        const ids = paths.flatMap(({ table: candidate }, index) => (candidate === table && values[index] ? [values[index]!] : []));
        return [table, await publicResources.publicIds(table, ids)] as const;
      }),
    ),
  );
  const replaceAtPath = (value: unknown, path: readonly string[], replacement: string): unknown => {
    if ((!isRecord(value) && !Array.isArray(value)) || path.length === 0) return value;
    const [segment, ...rest] = path;
    if (Array.isArray(value)) {
      const index = Number(segment);
      return value.map((item, candidate) =>
        candidate === index ? (rest.length === 0 ? replacement : replaceAtPath(item, rest, replacement)) : item,
      );
    }
    return {
      ...value,
      [segment!]: rest.length === 0 ? replacement : replaceAtPath(value[segment!], rest, replacement),
    };
  };
  let data: unknown = result.data;
  for (const [{ path, table }, id] of paths.map((entry, index) => [entry, values[index]] as const)) {
    if (!id) continue;
    data = replaceAtPath(data, path, publicResources.requirePublicId(maps.get(table)!, id));
  }
  return { ok: true, data: data as T };
};

type PublicSuccessResponse<T> = Response & TypedResponse<T, 200 | 201, "json">;
type PublicErrorResponse<E extends ServiceError> = Response & TypedResponse<unknown, E["status"], "json">;

export function respondPublic<E extends ServiceError>(
  c: Context<MailApiContext>,
  result: Result<never, E> | Promise<Result<never, E>>,
  rootTable?: RelationTable,
): Promise<PublicErrorResponse<E>>;
export function respondPublic<T>(
  c: Context<MailApiContext>,
  result: Result<T, never> | Promise<Result<T, never>>,
  rootTable?: RelationTable,
): Promise<PublicSuccessResponse<T>>;
export function respondPublic<T, E extends ServiceError>(
  c: Context<MailApiContext>,
  result: Result<T, E> | Promise<Result<T, E>>,
  rootTable?: RelationTable,
): Promise<PublicSuccessResponse<T> | PublicErrorResponse<E>>;
export function respondPublic<T>(
  c: Context<MailApiContext>,
  result: Result<T> | Promise<Result<T>>,
  rootTable?: RelationTable,
): Promise<PublicSuccessResponse<T> | ApiErrorResponse>;
export async function respondPublic<T>(
  c: Context<MailApiContext>,
  result: Result<T> | Promise<Result<T>>,
  rootTable?: RelationTable,
): Promise<PublicSuccessResponse<T> | ApiErrorResponse> {
  const projected = await projectPublicResult(await result, rootTable);
  return respond<T, ServiceError>(c, projected.ok ? projected : { ok: false, error: localizeMailError(projected.error, getLocale(c)) });
}

const requiredInternalId = (c: Context<MailApiContext>, variable: InternalVariable): string => {
  const id = c.get(variable);
  if (!id) throw new Error(`Mail public-resource middleware did not resolve ${variable}`);
  return id;
};

export const internalMailboxId = (c: Context<MailApiContext>): string => requiredInternalId(c, "internalMailboxId");

export const internalParams = <T extends Record<string, unknown>>(c: Context<MailApiContext>, params: T): T => {
  const resolved = { ...params };
  for (const [name, variable] of Object.entries(resolvedParamVariables) as Array<[PublicParam, InternalVariable]>) {
    if (name in resolved) Object.assign(resolved, { [name]: requiredInternalId(c, variable) });
  }
  return resolved;
};

export const resolveMailboxParam = async (c: Context<MailApiContext>, next: Next) => {
  const shortId = c.req.param("mailboxId");
  const mailboxId = shortId ? await publicResources.resolvePublicId("mailboxes", shortId) : null;
  if (!mailboxId) return respondPublic(c, fail(err.notFound("Mailbox")));
  c.set("internalMailboxId", mailboxId);
  await next();
};

export const resolveMailboxResourceParam =
  (table: publicResources.MailboxOwnedPublicResourceTable, param: PublicParam, label: string) =>
  async (c: Context<MailApiContext>, next: Next) => {
    const shortId = c.req.param(param);
    const id = shortId ? await publicResources.resolveMailboxPublicId(table, internalMailboxId(c), shortId) : null;
    if (!id) return respondPublic(c, fail(err.notFound(label)));
    c.set(resolvedParamVariables[param], id);
    await next();
  };

export const resolveReminderNotificationSourceParam = async (c: Context<MailApiContext>, next: Next) => {
  const shortId = c.req.param("sourceId");
  const id = shortId ? await publicResources.resolveReminderNotificationSourceId(internalMailboxId(c), shortId) : null;
  if (!id) return respondPublic(c, fail(err.notFound("Reminder")));
  c.set("internalReminderId", id);
  await next();
};
