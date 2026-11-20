import { z } from "zod";
import type { FolderRole, RemoteFolder } from "../../contracts";
import { jmapFolderStableKey } from "../provider-identity";
import { ENVELOPE_BATCH_SIZE } from "./contract";
import {
  callJmap,
  fetchJmapSession,
  JMAP_CORE,
  JMAP_JSON_BYTES,
  JMAP_MAIL,
  JMAP_SUBMISSION,
  type JmapAccess,
  JmapError,
  type JmapSession,
  jmapIdSchema,
  requireJmapMethodResult,
  validateJmapId,
} from "./jmap-client";
import { JMAP_EMAIL_BODY_PROPERTIES, JMAP_EMAIL_PROPERTIES, type JmapEmailSnapshot, jmapEmailSnapshotSchema } from "./jmap-email";
import { type JmapTransportDependencies, JmapTransportError } from "./jmap-transport";

function primaryMailAccount(session: JmapSession) {
  if (!session.capabilities[JMAP_MAIL] || !session.capabilities[JMAP_SUBMISSION]) throw new JmapError("JMAP_CAPABILITY");
  const accountId = session.primaryAccounts[JMAP_MAIL];
  const account = accountId && Object.hasOwn(session.accounts, accountId) ? session.accounts[accountId] : undefined;
  if (!accountId || !account || account.isReadOnly) throw new JmapError("JMAP_ACCOUNT");
  if (!account.accountCapabilities[JMAP_MAIL] || !account.accountCapabilities[JMAP_SUBMISSION]) throw new JmapError("JMAP_CAPABILITY");
  return { accountId, account };
}

export async function verifyJmap(input: JmapAccess, deps: JmapTransportDependencies = {}) {
  const session = await fetchJmapSession(input, deps);
  const { accountId, account } = primaryMailAccount(session);
  return { origin: session.origin, accountId, name: account.name, limits: session.core, username: session.username };
}

export const jmapMailboxRightsSchema = z.object({
  mayReadItems: z.boolean(),
  mayAddItems: z.boolean(),
  mayRemoveItems: z.boolean(),
  maySetSeen: z.boolean(),
  maySetKeywords: z.boolean(),
  mayCreateChild: z.boolean(),
  mayRename: z.boolean(),
  mayDelete: z.boolean(),
  maySubmit: z.boolean(),
});
export type JmapMailboxRights = z.infer<typeof jmapMailboxRightsSchema>;
/** Existing rights combine seen/keywords and folder deletion/rename. Do not widen either. */
export function mapJmapRights(rights: JmapMailboxRights): string[] {
  return [
    ...(rights.mayReadItems ? ["read"] : []),
    ...(rights.maySetSeen && rights.maySetKeywords ? ["write_flags"] : []),
    ...(rights.mayAddItems ? ["insert"] : []),
    ...(rights.mayRemoveItems ? ["move", "delete_messages"] : []),
    ...(rights.mayCreateChild ? ["create_children"] : []),
    ...(rights.mayDelete && rights.mayRename ? ["delete_folder"] : []),
    // maySubmit has no equivalent folder right; it never grants insert or ACL administration.
  ];
}

// Mail folder names in contracts.ts are at most 1,000 characters. Allow up to
// four UTF-8 bytes each locally; RFC 8621 maxSizeMailboxName can narrow this further.
const LOCAL_MAILBOX_NAME_BYTES = 4_000;
// IMAP discovery has no account folder-count cap. Bound each query walk to 1,024
// pages: even a server returning one object per page can expose 1,000 folders,
// but a stable, fabricated total cannot keep discovery running indefinitely.
// The subsequent get phase has at most as many pages (2,048 responses overall).
export const JMAP_DISCOVERY_PAGES = 1_024;
const RESPONSE_FRAME_BYTES = 4_096;
const MAILBOX_OVERHEAD_BYTES = 2_048; // Two 255-byte IDs, role, nine rights, keys and JSON framing.
const mailboxProperties = ["id", "name", "parentId", "role", "isSubscribed", "myRights"];

const mailboxSchema = z.object({
  id: jmapIdSchema,
  name: z.string().min(1),
  parentId: jmapIdSchema.nullable(),
  role: z.string().nullable(),
  isSubscribed: z.boolean(),
  myRights: jmapMailboxRightsSchema,
});
const querySchema = z.object({
  accountId: jmapIdSchema,
  queryState: z.string(),
  position: z.number().int().nonnegative(),
  ids: z.array(jmapIdSchema),
  total: z.number().int().nonnegative(),
});
const getSchema = z.object({ accountId: jmapIdSchema, state: z.string(), list: z.array(mailboxSchema), notFound: z.array(jmapIdSchema) });
export type JmapRemoteFolder = RemoteFolder & { mailboxId: string; parentMailboxId: string | null };

export async function discoverJmapFolders(input: JmapAccess, deps: JmapTransportDependencies = {}): Promise<JmapRemoteFolder[]> {
  const session = await fetchJmapSession(input, deps);
  const { accountId, account } = primaryMailAccount(session);
  const advertisedNameBytes = z.number().int().positive().safeParse(account.accountCapabilities[JMAP_MAIL]?.maxSizeMailboxName);
  const nameBytes = Math.min(advertisedNameBytes.success ? advertisedNameBytes.data : LOCAL_MAILBOX_NAME_BYTES, LOCAL_MAILBOX_NAME_BYTES);
  // JSON can escape each name byte as six ASCII bytes. Limit object count locally
  // using the existing metadata budget / per-object overhead, independently of server limits.
  const objectBytes = 6 * nameBytes + MAILBOX_OVERHEAD_BYTES;
  const batchSize = Math.min(session.core.maxObjectsInGet, Math.floor(JMAP_JSON_BYTES / MAILBOX_OVERHEAD_BYTES));
  const method = async (name: string, args: Record<string, unknown>, maxBytes: number) => {
    input.signal.throwIfAborted();
    const response = await callJmap(
      {
        session,
        maxBytes,
        authorization: input.authorization,
        signal: input.signal,
        using: [JMAP_CORE, JMAP_MAIL],
        methodCalls: [[name, { accountId, ...args }, "folders"]],
      },
      deps,
    );
    return requireJmapMethodResult(response, "folders", name);
  };
  const ids: string[] = [];
  const seen = new Set<string>();
  let queryState: string | undefined;
  let total: number | undefined;
  let pages = 0;
  do {
    if (++pages > JMAP_DISCOVERY_PAGES) throw new JmapError("JMAP_DISCOVERY_LIMIT");
    const parsed = querySchema.safeParse(
      await method(
        "Mailbox/query",
        { position: ids.length, limit: batchSize, calculateTotal: true },
        RESPONSE_FRAME_BYTES + batchSize * 258,
      ),
    );
    if (!parsed.success) throw new JmapError("JMAP_INVALID_RESPONSE");
    const page = parsed.data;
    if (
      page.accountId !== accountId ||
      page.position !== ids.length ||
      (queryState !== undefined && page.queryState !== queryState) ||
      (total !== undefined && page.total !== total) ||
      page.ids.length > batchSize
    )
      throw new JmapError("JMAP_INVALID_RESPONSE");
    queryState = page.queryState;
    total = page.total;
    if (!page.ids.length && ids.length < total) throw new JmapError("JMAP_INVALID_RESPONSE");
    for (const id of page.ids) {
      if (seen.has(id)) throw new JmapError("JMAP_INVALID_RESPONSE");
      seen.add(id);
      ids.push(id);
    }
    if (ids.length > total) throw new JmapError("JMAP_INVALID_RESPONSE");
  } while (ids.length < total);

  const mailboxes = new Map<string, z.infer<typeof mailboxSchema>>();
  let state: string | undefined;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const parsed = getSchema.safeParse(
      await method("Mailbox/get", { ids: batch, properties: mailboxProperties }, RESPONSE_FRAME_BYTES + batch.length * objectBytes),
    );
    if (!parsed.success) throw new JmapError("JMAP_INVALID_RESPONSE");
    const page = parsed.data;
    if (
      page.accountId !== accountId ||
      page.notFound.length ||
      (state !== undefined && page.state !== state) ||
      page.list.length !== batch.length
    )
      throw new JmapError("JMAP_INVALID_RESPONSE");
    state = page.state;
    for (const mailbox of page.list) {
      if (Buffer.byteLength(mailbox.name) > nameBytes) throw new JmapError("JMAP_DISCOVERY_LIMIT");
      if (!batch.includes(mailbox.id) || mailboxes.has(mailbox.id)) throw new JmapError("JMAP_INVALID_RESPONSE");
      mailboxes.set(mailbox.id, mailbox);
    }
  }

  const paths = new Map<string, string>();
  for (const mailbox of mailboxes.values()) {
    const chain: z.infer<typeof mailboxSchema>[] = [];
    const ancestors = new Set<string>();
    let current: z.infer<typeof mailboxSchema> | undefined = mailbox;
    while (current && !paths.has(current.id)) {
      if (ancestors.has(current.id)) throw new JmapError("JMAP_FOLDER_TREE");
      ancestors.add(current.id);
      chain.push(current);
      const parentId: string | null = current.parentId;
      current = parentId ? mailboxes.get(parentId) : undefined;
      if (parentId && !current) throw new JmapError("JMAP_FOLDER_TREE");
    }
    while (chain.length) {
      const entry = chain.pop();
      if (!entry) throw new JmapError("JMAP_FOLDER_TREE");
      const parent = entry.parentId ? paths.get(entry.parentId) : undefined;
      const path = parent === undefined ? entry.name : `${parent}/${entry.name}`;
      paths.set(entry.id, Array.from(path).slice(0, 4_000).join(""));
    }
  }
  const pathFor = (id: string): string => {
    const path = paths.get(id);
    if (path === undefined) throw new JmapError("JMAP_FOLDER_TREE");
    return path;
  };
  return [...mailboxes.values()].map((mailbox) => ({
    mailboxId: mailbox.id,
    parentMailboxId: mailbox.parentId,
    stableKey: jmapFolderStableKey({ version: 1, kind: "jmap", origin: session.origin, accountId }, mailbox.id),
    path: pathFor(mailbox.id),
    name: mailbox.name,
    parentPath: mailbox.parentId ? pathFor(mailbox.parentId) : null,
    delimiter: "/",
    role: folderRole(mailbox.role),
    subscribed: mailbox.isSubscribed,
    selectable: mailbox.myRights.mayReadItems,
    rights: mapJmapRights(mailbox.myRights),
    rightsSource: "acl",
    uidValidity: null,
    uidNext: null,
    highestModseq: null,
  }));
}

function folderRole(role: string | null): FolderRole {
  switch (role) {
    case "inbox":
    case "sent":
    case "drafts":
    case "trash":
    case "junk":
    case "archive":
      return role;
    default:
      return "other";
  }
}

// Same budget as MAX_MESSAGE_HEADER_BYTES in message-protocol.ts, for metadata only.
export const JMAP_EMAIL_RESPONSE_BYTES = 2 * 1024 * 1024;
const emailGetSchema = z.object({
  accountId: jmapIdSchema,
  state: z.string(),
  list: z.array(jmapEmailSnapshotSchema),
  notFound: z.array(jmapIdSchema),
});

/** Bounded Email/get only. No checkpoint or mailbox projection is performed here. */
export async function readJmapEmails(
  session: JmapSession,
  authorization: string,
  accountId: string,
  ids: readonly string[],
  signal: AbortSignal,
  deps: JmapTransportDependencies = {},
): Promise<{ objects: JmapEmailSnapshot[]; notFoundIds: string[] }> {
  validateJmapId(accountId);
  const account = Object.hasOwn(session.accounts, accountId) ? session.accounts[accountId] : undefined;
  if (!account) throw new JmapError("JMAP_ACCOUNT");
  if (!session.capabilities[JMAP_MAIL] || !account.accountCapabilities[JMAP_MAIL]) throw new JmapError("JMAP_CAPABILITY");
  for (const id of ids) validateJmapId(id);
  if (new Set(ids).size !== ids.length) throw new JmapError("JMAP_INVALID_ID");
  const objects: JmapEmailSnapshot[] = [];
  const notFoundIds: string[] = [];
  let batchSize = Math.min(ENVELOPE_BATCH_SIZE, session.core.maxObjectsInGet);
  for (let offset = 0; offset < ids.length; ) {
    if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
    const batch = ids.slice(offset, offset + batchSize);
    let response: Awaited<ReturnType<typeof callJmap>>;
    try {
      response = await callJmap(
        {
          session,
          authorization,
          signal,
          using: [JMAP_CORE, JMAP_MAIL],
          methodCalls: [
            [
              "Email/get",
              { accountId, ids: batch, properties: JMAP_EMAIL_PROPERTIES, bodyProperties: JMAP_EMAIL_BODY_PROPERTIES },
              "emails",
            ],
          ],
          maxBytes: JMAP_EMAIL_RESPONSE_BYTES,
        },
        deps,
      );
    } catch (error) {
      if (!(error instanceof JmapTransportError) || error.code !== "JMAP_TOO_LARGE") throw error;
      if (batch.length === 1) throw new JmapError("JMAP_EMAIL_TOO_LARGE");
      batchSize = Math.max(1, Math.floor(batch.length / 2));
      continue;
    }
    const parsed = emailGetSchema.safeParse(requireJmapMethodResult(response, "emails", "Email/get"));
    if (!parsed.success || parsed.data.accountId !== accountId) throw new JmapError("JMAP_INVALID_RESPONSE");
    const page = parsed.data;
    const remaining = new Set(batch);
    for (const id of [...page.list.map((email) => email.id), ...page.notFound]) {
      if (!remaining.delete(id)) throw new JmapError("JMAP_INVALID_RESPONSE");
    }
    if (remaining.size) throw new JmapError("JMAP_INVALID_RESPONSE");
    objects.push(...page.list);
    notFoundIds.push(...page.notFound);
    offset += batch.length;
  }
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  return { objects, notFoundIds };
}
