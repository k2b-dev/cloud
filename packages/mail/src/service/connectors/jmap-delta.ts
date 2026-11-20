import { z } from "zod";
import { ENVELOPE_BATCH_SIZE } from "./contract";
import {
  JMAP_DISCOVERY_PAGES,
  JMAP_EMAIL_RESPONSE_BYTES,
  type JmapRemoteFolder,
  jmapMailboxBudget,
  mailboxGetSchema,
  mailboxProperties,
  mapJmapMailboxes,
  parseJmapEmailGet,
  readJmapEmails,
} from "./jmap";
import {
  callJmap,
  JMAP_CORE,
  JMAP_JSON_BYTES,
  JMAP_MAIL,
  JmapError,
  type JmapInvocation,
  JmapMethodError,
  type JmapSession,
  jmapIdSchema,
  requireJmapMethodResult,
  validateJmapId,
} from "./jmap-client";
import { JMAP_EMAIL_BODY_PROPERTIES, JMAP_EMAIL_PROPERTIES, type JmapEmailSnapshot } from "./jmap-email";
import { jmapStateSchema } from "./jmap-sync-state";
import { type JmapTransportDependencies, JmapTransportError } from "./jmap-transport";

const changesSchema = z.object({
  accountId: jmapIdSchema,
  oldState: jmapStateSchema,
  newState: jmapStateSchema,
  hasMoreChanges: z.boolean(),
  created: z.array(jmapIdSchema),
  updated: z.array(jmapIdSchema),
  destroyed: z.array(jmapIdSchema),
  updatedProperties: z.array(z.string()).nullable().optional(),
});
export class JmapReconciliationRequiredError extends Error {
  readonly code = "JMAP_RECONCILIATION_REQUIRED";
  constructor(override readonly cause: "cannot_calculate" | "state_rejected") {
    super("JMAP_RECONCILIATION_REQUIRED");
    this.name = "JmapReconciliationRequiredError";
  }
}

type Checkpoint = { oldState: string; newState: string; hasMoreChanges: boolean };
export type JmapEmailDelta = Checkpoint & {
  createdIds: string[];
  updatedIds: string[];
  destroyedIds: string[];
  notFoundIds: string[];
  objects: JmapEmailSnapshot[];
};
export type JmapMailboxDelta = Checkpoint & {
  created: JmapRemoteFolder[];
  updated: JmapRemoteFolder[];
  destroyedIds: string[];
  notFoundIds: string[];
};

function validateInput(session: JmapSession, accountId: string, sinceState: string, signal: AbortSignal) {
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  validateJmapId(accountId);
  if (!jmapStateSchema.safeParse(sinceState).success) throw new JmapError("JMAP_INVALID_RESPONSE");
  const account = Object.hasOwn(session.accounts, accountId) ? session.accounts[accountId] : undefined;
  if (!account) throw new JmapError("JMAP_ACCOUNT");
  if (!session.capabilities[JMAP_MAIL] || !account.accountCapabilities[JMAP_MAIL]) throw new JmapError("JMAP_CAPABILITY");
}

function parseChanges(
  response: Awaited<ReturnType<typeof callJmap>>,
  method: string,
  accountId: string,
  sinceState: string,
  maxChanges: number,
) {
  let value: Record<string, unknown>;
  try {
    value = requireJmapMethodResult(response, "changes", method);
  } catch (error) {
    // Evaluate changes before dependent gets: invalidResultReference must not hide a rejected state.
    if (error instanceof JmapMethodError) {
      if (error.methodType === "cannotCalculateChanges") throw new JmapReconciliationRequiredError("cannot_calculate");
      if (error.methodType === "invalidArguments") throw new JmapReconciliationRequiredError("state_rejected");
    }
    throw error;
  }
  const parsed = changesSchema.safeParse(value);
  if (!parsed.success) throw new JmapError("JMAP_INVALID_RESPONSE");
  const page = parsed.data;
  const lists = [page.created, page.updated, page.destroyed];
  if (
    page.accountId !== accountId ||
    page.oldState !== sinceState ||
    lists.reduce((count, list) => count + list.length, 0) > maxChanges ||
    lists.some((list) => new Set(list).size !== list.length) ||
    (page.hasMoreChanges && page.newState === page.oldState)
  ) {
    throw new JmapError("JMAP_INVALID_RESPONSE");
  }
  // RFC 8620 §5.2 may repeat an id across lists: destroyed wins, then created; the result is disjoint.
  const destroyed = new Set(page.destroyed);
  const created = page.created.filter((id) => !destroyed.has(id));
  const createdSet = new Set(created);
  const updated = page.updated.filter((id) => !destroyed.has(id) && !createdSet.has(id));
  return { ...page, created, updated, sent: { created: page.created, updated: page.updated } };
}

/** One account-wide page; only changes.newState is a checkpoint, never get.state. */
export async function readJmapEmailDelta(
  session: JmapSession,
  authorization: string,
  accountId: string,
  sinceState: string,
  signal: AbortSignal,
  deps: JmapTransportDependencies = {},
): Promise<JmapEmailDelta> {
  validateInput(session, accountId, sinceState, signal);
  const maxChanges = Math.min(ENVELOPE_BATCH_SIZE, session.core.maxObjectsInGet);
  const changes: JmapInvocation = ["Email/changes", { accountId, sinceState, maxChanges }, "changes"];
  const get = (path: "created" | "updated"): JmapInvocation => [
    "Email/get",
    {
      accountId,
      "#ids": { resultOf: "changes", name: "Email/changes", path: `/${path}` },
      properties: JMAP_EMAIL_PROPERTIES,
      bodyProperties: JMAP_EMAIL_BODY_PROPERTIES,
    },
    path,
  ];
  const request = (combined: boolean) =>
    callJmap(
      {
        session,
        authorization,
        signal,
        using: [JMAP_CORE, JMAP_MAIL],
        methodCalls: combined ? [changes, get("created"), get("updated")] : [changes],
        maxBytes: combined ? JMAP_EMAIL_RESPONSE_BYTES : JMAP_JSON_BYTES,
      },
      deps,
    );
  let combined = session.core.maxCallsInRequest >= 3;
  let response: Awaited<ReturnType<typeof callJmap>>;
  try {
    response = await request(combined);
  } catch (error) {
    if (!combined || !(error instanceof JmapTransportError) || error.code !== "JMAP_TOO_LARGE") throw error;
    combined = false;
    response = await request(false);
  }
  const page = parseChanges(response, "Email/changes", accountId, sinceState, maxChanges);
  let objects: JmapEmailSnapshot[] = [];
  let notFoundIds: string[] = [];
  if (combined) {
    // The back-references read the lists as sent; keep each id of the normalized lists exactly once.
    const created = parseJmapEmailGet(requireJmapMethodResult(response, "created", "Email/get"), accountId, page.sent.created);
    const updated = parseJmapEmailGet(requireJmapMethodResult(response, "updated", "Email/get"), accountId, page.sent.updated);
    const wanted = new Set([...page.created, ...page.updated]);
    for (const get of [created, updated]) {
      objects.push(...get.list.filter((email) => wanted.delete(email.id)));
      notFoundIds.push(...get.notFound.filter((id) => wanted.delete(id)));
    }
  } else {
    ({ objects, notFoundIds } = await readJmapEmails(session, authorization, accountId, [...page.created, ...page.updated], signal, deps));
  }
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  return {
    oldState: page.oldState,
    newState: page.newState,
    hasMoreChanges: page.hasMoreChanges,
    createdIds: page.created,
    updatedIds: page.updated,
    destroyedIds: page.destroyed,
    notFoundIds,
    objects,
  };
}

const counters = new Set(["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]);

/** Parents are fetched only to resolve paths; created/updated contain changed mailboxes only. */
export async function readJmapMailboxDelta(
  session: JmapSession,
  authorization: string,
  accountId: string,
  sinceState: string,
  signal: AbortSignal,
  deps: JmapTransportDependencies = {},
): Promise<JmapMailboxDelta> {
  validateInput(session, accountId, sinceState, signal);
  const budget = jmapMailboxBudget(session, accountId);
  const method = (name: string, args: Record<string, unknown>, id: string, maxBytes: number) =>
    callJmap(
      { session, authorization, signal, using: [JMAP_CORE, JMAP_MAIL], maxBytes, methodCalls: [[name, { accountId, ...args }, id]] },
      deps,
    );
  const page = parseChanges(
    await method("Mailbox/changes", { sinceState, maxChanges: budget.batchSize }, "changes", JMAP_JSON_BYTES),
    "Mailbox/changes",
    accountId,
    sinceState,
    budget.batchSize,
  );
  const countersOnly =
    page.updatedProperties !== undefined &&
    page.updatedProperties !== null &&
    page.updatedProperties.every((property) => counters.has(property));
  const ids = [...page.created, ...(countersOnly ? [] : page.updated)];
  const mailboxes = new Map<string, z.infer<typeof mailboxGetSchema>["list"][number]>();
  const notFoundIds: string[] = [];
  let pending = ids;
  let pages = 0;
  while (pending.length) {
    if (++pages > JMAP_DISCOVERY_PAGES) throw new JmapError("JMAP_DISCOVERY_LIMIT");
    const batch = pending.slice(0, budget.batchSize);
    const response = await method(
      "Mailbox/get",
      { ids: batch, properties: mailboxProperties },
      "mailboxes",
      budget.frameBytes + batch.length * budget.objectBytes,
    );
    const parsed = mailboxGetSchema.safeParse(requireJmapMethodResult(response, "mailboxes", "Mailbox/get"));
    if (!parsed.success || parsed.data.accountId !== accountId || !jmapStateSchema.safeParse(parsed.data.state).success)
      throw new JmapError("JMAP_INVALID_RESPONSE");
    const remaining = new Set(batch);
    for (const id of [...parsed.data.list.map((mailbox) => mailbox.id), ...parsed.data.notFound]) {
      if (!remaining.delete(id)) throw new JmapError("JMAP_INVALID_RESPONSE");
    }
    if (remaining.size) throw new JmapError("JMAP_INVALID_RESPONSE");
    for (const mailbox of parsed.data.list) {
      if (Buffer.byteLength(mailbox.name) > budget.nameBytes) throw new JmapError("JMAP_DISCOVERY_LIMIT");
      mailboxes.set(mailbox.id, mailbox);
    }
    for (const id of parsed.data.notFound) {
      if (!ids.includes(id)) throw new JmapError("JMAP_FOLDER_TREE");
      notFoundIds.push(id);
    }
    pending = [
      ...new Set([
        ...pending.slice(batch.length),
        ...[...mailboxes.values()].flatMap((mailbox) => (mailbox.parentId && !mailboxes.has(mailbox.parentId) ? [mailbox.parentId] : [])),
      ]),
    ];
    if (pending.some((id) => notFoundIds.includes(id))) throw new JmapError("JMAP_FOLDER_TREE");
  }
  const folders = mapJmapMailboxes(session, accountId, mailboxes);
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  return {
    oldState: page.oldState,
    newState: page.newState,
    hasMoreChanges: page.hasMoreChanges,
    created: folders.filter((folder) => page.created.includes(folder.mailboxId)),
    updated: folders.filter((folder) => !countersOnly && page.updated.includes(folder.mailboxId)),
    destroyedIds: page.destroyed,
    notFoundIds,
  };
}
