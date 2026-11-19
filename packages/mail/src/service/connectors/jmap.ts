import { z } from "zod";
import type { FolderRole, RemoteFolder } from "../../contracts";
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
} from "./jmap-client";
import type { JmapTransportDependencies } from "./jmap-transport";

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
export type JmapRemoteFolder = RemoteFolder & { mailboxId: string };

export async function discoverJmapFolders(input: JmapAccess, deps: JmapTransportDependencies = {}): Promise<JmapRemoteFolder[]> {
  const session = await fetchJmapSession(input, deps);
  const { accountId } = primaryMailAccount(session);
  // Bound the entire discovery, not just each response: a server cannot force an endless query walk.
  let bytes = 0;
  const method = async (name: string, args: Record<string, unknown>) => {
    input.signal.throwIfAborted();
    const response = await callJmap(
      {
        session,
        authorization: input.authorization,
        signal: input.signal,
        using: [JMAP_CORE, JMAP_MAIL],
        methodCalls: [[name, { accountId, ...args }, "folders"]],
      },
      deps,
    );
    bytes += Buffer.byteLength(JSON.stringify(response));
    if (bytes > JMAP_JSON_BYTES) throw new JmapError("JMAP_DISCOVERY_LIMIT");
    const result = response.methodResponses[0];
    if (response.methodResponses.length !== 1 || !result || result[0] !== name || result[2] !== "folders")
      throw new JmapError("JMAP_INVALID_RESPONSE");
    return result[1];
  };
  const ids: string[] = [];
  const seen = new Set<string>();
  let queryState: string | undefined;
  let total: number | undefined;
  do {
    const parsed = querySchema.safeParse(
      await method("Mailbox/query", { position: ids.length, limit: session.core.maxObjectsInGet, calculateTotal: true }),
    );
    if (!parsed.success) throw new JmapError("JMAP_INVALID_RESPONSE");
    const page = parsed.data;
    if (
      page.accountId !== accountId ||
      page.position !== ids.length ||
      (queryState !== undefined && page.queryState !== queryState) ||
      (total !== undefined && page.total !== total) ||
      page.ids.length > session.core.maxObjectsInGet
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
  for (let offset = 0; offset < ids.length; offset += session.core.maxObjectsInGet) {
    const batch = ids.slice(offset, offset + session.core.maxObjectsInGet);
    const parsed = getSchema.safeParse(await method("Mailbox/get", { ids: batch }));
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
      if (!batch.includes(mailbox.id) || mailboxes.has(mailbox.id)) throw new JmapError("JMAP_INVALID_RESPONSE");
      mailboxes.set(mailbox.id, mailbox);
    }
  }

  const paths = new Map<string, string>();
  const usedPaths = new Set<string>();
  for (const mailbox of mailboxes.values()) {
    const chain: z.infer<typeof mailboxSchema>[] = [];
    const ancestors = new Set<string>();
    let current: z.infer<typeof mailboxSchema> | undefined = mailbox;
    while (current && !paths.has(current.id)) {
      if (ancestors.has(current.id) || current.name.includes("/")) throw new JmapError("JMAP_FOLDER_TREE");
      ancestors.add(current.id);
      chain.push(current);
      const parentId: string | null = current.parentId;
      current = parentId ? mailboxes.get(parentId) : undefined;
      if (parentId && !current) throw new JmapError("JMAP_FOLDER_TREE");
    }
    while (chain.length) {
      const entry = chain.pop()!;
      const parent = entry.parentId ? paths.get(entry.parentId) : undefined;
      const path = parent === undefined ? entry.name : `${parent}/${entry.name}`;
      bytes += Buffer.byteLength(path);
      if (bytes > JMAP_JSON_BYTES) throw new JmapError("JMAP_DISCOVERY_LIMIT");
      if (usedPaths.has(path)) throw new JmapError("JMAP_FOLDER_TREE");
      paths.set(entry.id, path);
      usedPaths.add(path);
    }
  }
  return [...mailboxes.values()].map((mailbox) => ({
    mailboxId: mailbox.id,
    stableKey: mailbox.id,
    path: paths.get(mailbox.id)!,
    name: mailbox.name,
    parentPath: mailbox.parentId ? paths.get(mailbox.parentId)! : null,
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
