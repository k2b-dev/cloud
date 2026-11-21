import { z } from "zod";
import { ENVELOPE_BATCH_SIZE } from "./contract";
import {
  JMAP_EMAIL_RESPONSE_BYTES,
  type JmapRemoteFolder,
  mapJmapMailboxes,
  parseJmapEmailGet,
  readJmapEmails,
  readJmapMailboxInventory,
} from "./jmap";
import {
  callJmap,
  JMAP_CORE,
  JMAP_JSON_BYTES,
  JMAP_MAIL,
  JmapError,
  type JmapInvocation,
  type JmapSession,
  jmapIdSchema,
  requireJmapMethodResult,
  validateJmapId,
} from "./jmap-client";
import { JMAP_EMAIL_BODY_PROPERTIES, JMAP_EMAIL_PROPERTIES, type JmapEmailSnapshot } from "./jmap-email";
import { jmapStateSchema } from "./jmap-sync-state";
import { type JmapTransportDependencies, JmapTransportError } from "./jmap-transport";

// Network readers for a complete account scan. They hold no state and write nothing: the caller
// stores `next` together with the page it committed, so a crash repeats at most one page.

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A whole UTC second. Scan bounds come only from receivedAt values the server returned. */
export const jmapUtcSecondSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, -1)}.000Z`);
export const jmapScanStepSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("query"), before: jmapUtcSecondSchema.nullable() }).strict(),
    z.object({ kind: z.literal("bucket"), second: jmapUtcSecondSchema, position: count, queryState: jmapStateSchema.nullable() }).strict(),
    // The verify pass pages through local refs in (folder, Email ID) order, as their index does.
    z.object({ kind: z.literal("verify"), after: z.object({ folderId: z.uuid(), emailId: jmapIdSchema }).strict().nullable() }).strict(),
  ])
  // Positions are only comparable within one query result (RFC 8620 §5.5).
  .refine((step) => step.kind !== "bucket" || step.position === 0 || step.queryState !== null);
export type JmapScanStep = z.infer<typeof jmapScanStepSchema>;
export type JmapScanPageStep = Exclude<JmapScanStep, { kind: "verify" }>;
/**
 * `emailState` is the Email state of the step's last get. The caller applies a step only when it
 * equals its stored state: otherwise mail changed since the last delta, and a new message must
 * reach the account through the delta first, as an arrival.
 */
export type JmapScanPage =
  /** Objects of completed seconds in query order; a second the next step reads again is left out. */
  | { kind: "page"; objects: JmapEmailSnapshot[]; notFoundIds: string[]; next: JmapScanStep; emailState: string }
  /** Nothing to apply: the bucket's result list changed, or every ID of a non-final page vanished. */
  | { kind: "restart"; next: JmapScanPageStep; emailState: string };

const emailQuerySchema = z.object({
  accountId: jmapIdSchema,
  queryState: jmapStateSchema,
  position: count,
  ids: z.array(jmapIdSchema),
  total: count,
  limit: count.optional(),
});

function requireMailAccount(session: JmapSession, accountId: string, signal: AbortSignal) {
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  validateJmapId(accountId);
  const account = Object.hasOwn(session.accounts, accountId) ? session.accounts[accountId] : undefined;
  if (!account) throw new JmapError("JMAP_ACCOUNT");
  if (!session.capabilities[JMAP_MAIL] || !account.accountCapabilities[JMAP_MAIL]) throw new JmapError("JMAP_CAPABILITY");
}

type ReceivedKey = { second: number; fraction: string };
/** receivedAt is a UTCDate (RFC 8620 §1.4); fractions may exceed millisecond precision. */
function receivedKey(value: string): ReceivedKey {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?Z$/.exec(value);
  const whole = match ? Date.parse(`${match[1]}:${match[2] ?? "00"}Z`) : Number.NaN;
  if (!match || !Number.isFinite(whole)) throw new JmapError("JMAP_INVALID_RESPONSE");
  return { second: whole / 1_000, fraction: (match[3] ?? "").replace(/0+$/, "") };
}
function compareReceived(a: ReceivedKey, b: ReceivedKey): number {
  if (a.second !== b.second) return a.second - b.second;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const left = a.fraction.padEnd(width, "0");
  const right = b.fraction.padEnd(width, "0");
  return left < right ? -1 : left > right ? 1 : 0;
}
const utcSecond = (second: number) => new Date(second * 1_000).toISOString().replace(".000Z", "Z");
const secondOf = (value: string) => Date.parse(value) / 1_000;

/**
 * One scan step: Email/query by receivedAt (newest first) and Email/get for its IDs. The page
 * size is the envelope batch, halved while a response exceeds the metadata budget.
 */
export async function readJmapScanPage(
  session: JmapSession,
  authorization: string,
  accountId: string,
  step: JmapScanPageStep,
  signal: AbortSignal,
  deps: JmapTransportDependencies = {},
): Promise<JmapScanPage> {
  requireMailAccount(session, accountId, signal);
  const parsedStep = jmapScanStepSchema.safeParse(step);
  if (!parsedStep.success || parsedStep.data.kind === "verify") throw new RangeError("JMAP scan step cannot be read as a page");
  // RFC 8621 §4.4.1: before is exclusive, after inclusive. A bucket is exactly one UTC second.
  const before = step.kind === "query" ? step.before : utcSecond(secondOf(step.second) + 1);
  const after = step.kind === "bucket" ? step.second : null;
  const position = step.kind === "bucket" ? step.position : 0;
  const filter = step.kind === "bucket" ? { after, before } : before === null ? undefined : { before };
  const combined = session.core.maxCallsInRequest >= 2;
  let limit = Math.min(ENVELOPE_BATCH_SIZE, session.core.maxObjectsInGet);
  for (;;) {
    if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
    const query: JmapInvocation = [
      "Email/query",
      {
        accountId,
        ...(filter ? { filter } : {}),
        sort: [{ property: "receivedAt", isAscending: false }],
        position,
        limit,
        calculateTotal: true,
        collapseThreads: false,
      },
      "scan",
    ];
    const get: JmapInvocation = [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "scan", name: "Email/query", path: "/ids" },
        properties: JMAP_EMAIL_PROPERTIES,
        bodyProperties: JMAP_EMAIL_BODY_PROPERTIES,
      },
      "objects",
    ];
    let response: Awaited<ReturnType<typeof callJmap>>;
    try {
      response = await callJmap(
        {
          session,
          authorization,
          signal,
          using: [JMAP_CORE, JMAP_MAIL],
          methodCalls: combined ? [query, get] : [query],
          maxBytes: combined ? JMAP_EMAIL_RESPONSE_BYTES : JMAP_JSON_BYTES,
        },
        deps,
      );
    } catch (error) {
      if (!combined || !(error instanceof JmapTransportError) || error.code !== "JMAP_TOO_LARGE") throw error;
      if (limit === 1) throw new JmapError("JMAP_EMAIL_TOO_LARGE");
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    // The query outranks its dependent get: unsupportedSort must not surface as invalidResultReference.
    const parsed = emailQuerySchema.safeParse(requireJmapMethodResult(response, "scan", "Email/query"));
    if (!parsed.success || parsed.data.accountId !== accountId) throw new JmapError("JMAP_INVALID_RESPONSE");
    const page = parsed.data;
    const combinedGet = combined ? parseJmapEmailGet(requireJmapMethodResult(response, "objects", "Email/get"), accountId, page.ids) : null;
    if (step.kind === "bucket" && step.queryState !== null && page.queryState !== step.queryState)
      return {
        kind: "restart",
        next: { kind: "bucket", second: step.second, position: 0, queryState: null },
        emailState: combinedGet?.state ?? (await readEmptyGetState(session, authorization, accountId, "Email/get", signal, deps)),
      };
    const end = position + page.ids.length === page.total;
    if (
      page.position !== position ||
      new Set(page.ids).size !== page.ids.length ||
      page.ids.length > Math.min(limit, page.limit ?? limit) ||
      position + page.ids.length > page.total ||
      (!page.ids.length && !end)
    )
      throw new JmapError("JMAP_INVALID_RESPONSE");
    let objects: JmapEmailSnapshot[];
    let notFoundIds: string[];
    let emailState: string;
    if (combinedGet) {
      objects = combinedGet.list;
      notFoundIds = combinedGet.notFound;
      emailState = combinedGet.state;
    } else {
      const read = await readJmapEmails(session, authorization, accountId, page.ids, signal, deps);
      ({ objects, notFoundIds } = read);
      // An empty final page needs no get of its IDs; an empty get still reports the state.
      emailState = read.state ?? (await readEmptyGetState(session, authorization, accountId, "Email/get", signal, deps));
    }
    // Email/get has no defined order: check range and newest-first order in query order, by ID.
    const byId = new Map(objects.map((email) => [email.id, email]));
    const ordered: JmapEmailSnapshot[] = [];
    let previous: ReceivedKey | undefined;
    for (const id of page.ids) {
      const email = byId.get(id);
      if (!email) continue;
      const key = receivedKey(email.receivedAt);
      if (
        (before !== null && key.second >= secondOf(before)) ||
        (after !== null && key.second < secondOf(after)) ||
        (previous && compareReceived(key, previous) > 0)
      )
        throw new JmapError("JMAP_INVALID_RESPONSE");
      previous = key;
      ordered.push(email);
    }
    if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
    // A vanished ID still counts for a bucket position, but never yields a time bound.
    if (!end && !ordered.length) return { kind: "restart", next: step, emailState };
    let next: JmapScanStep;
    let completed = ordered;
    if (step.kind === "bucket")
      next = end
        ? { kind: "query", before: step.second }
        : { kind: "bucket", second: step.second, position: position + page.ids.length, queryState: page.queryState };
    else if (end) next = { kind: "verify", after: null };
    else {
      // The oldest second may continue beyond this page, so the next step reads it again in full.
      // Return only newer seconds: without a bucket restart, every object is returned once.
      const oldest = Math.min(...ordered.map((email) => receivedKey(email.receivedAt).second));
      completed = ordered.filter((email) => receivedKey(email.receivedAt).second > oldest);
      next = completed.length
        ? { kind: "query", before: utcSecond(oldest + 1) }
        : { kind: "bucket", second: utcSecond(oldest), position: 0, queryState: null };
    }
    const checked = jmapScanStepSchema.safeParse(next);
    if (!checked.success) throw new JmapError("JMAP_INVALID_RESPONSE");
    return { kind: "page", objects: completed, notFoundIds, next: checked.data, emailState };
  }
}

const JMAP_EXISTENCE_IDS = 500;
/** The largest input readJmapEmailExistence accepts for this session; callers page by it. */
export const jmapEmailExistenceLimit = (session: JmapSession) => Math.min(JMAP_EXISTENCE_IDS, session.core.maxObjectsInGet);
const existenceSchema = z.object({
  accountId: jmapIdSchema,
  state: jmapStateSchema,
  list: z.array(z.object({ id: jmapIdSchema })),
  notFound: z.array(jmapIdSchema),
});

/** One small Email/get for IDs only. Each input ID is returned exactly once, found or not. */
export async function readJmapEmailExistence(
  session: JmapSession,
  authorization: string,
  accountId: string,
  emailIds: readonly string[],
  signal: AbortSignal,
  deps: JmapTransportDependencies = {},
): Promise<{ foundIds: string[]; notFoundIds: string[] }> {
  requireMailAccount(session, accountId, signal);
  if (emailIds.length > jmapEmailExistenceLimit(session)) throw new RangeError("JMAP existence check exceeds one request");
  for (const id of emailIds) validateJmapId(id);
  if (new Set(emailIds).size !== emailIds.length) throw new JmapError("JMAP_INVALID_ID");
  if (!emailIds.length) return { foundIds: [], notFoundIds: [] };
  const response = await callJmap(
    {
      session,
      authorization,
      signal,
      using: [JMAP_CORE, JMAP_MAIL],
      methodCalls: [["Email/get", { accountId, ids: emailIds, properties: ["id"] }, "existence"]],
      maxBytes: JMAP_JSON_BYTES,
    },
    deps,
  );
  const parsed = existenceSchema.safeParse(requireJmapMethodResult(response, "existence", "Email/get"));
  if (!parsed.success || parsed.data.accountId !== accountId) throw new JmapError("JMAP_INVALID_RESPONSE");
  const found = new Set(parsed.data.list.map((email) => email.id));
  const remaining = new Set(emailIds);
  for (const id of [...parsed.data.list.map((email) => email.id), ...parsed.data.notFound]) {
    if (!remaining.delete(id)) throw new JmapError("JMAP_INVALID_RESPONSE");
  }
  if (remaining.size) throw new JmapError("JMAP_INVALID_RESPONSE");
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  return { foundIds: emailIds.filter((id) => found.has(id)), notFoundIds: emailIds.filter((id) => !found.has(id)) };
}

const emptyGetSchema = z.object({
  accountId: jmapIdSchema,
  state: jmapStateSchema,
  list: z.array(z.unknown()),
  notFound: z.array(z.unknown()),
});
/** The state of an Email/get or Mailbox/get for no IDs. */
async function readEmptyGetState(
  session: JmapSession,
  authorization: string,
  accountId: string,
  name: "Email/get" | "Mailbox/get",
  signal: AbortSignal,
  deps: JmapTransportDependencies,
): Promise<string> {
  const response = await callJmap(
    {
      session,
      authorization,
      signal,
      using: [JMAP_CORE, JMAP_MAIL],
      methodCalls: [[name, { accountId, ids: [], properties: ["id"] }, "start"]],
      maxBytes: JMAP_JSON_BYTES,
    },
    deps,
  );
  const parsed = emptyGetSchema.safeParse(requireJmapMethodResult(response, "start", name));
  if (!parsed.success || parsed.data.accountId !== accountId || parsed.data.list.length || parsed.data.notFound.length)
    throw new JmapError("JMAP_INVALID_RESPONSE");
  return parsed.data.state;
}

export type JmapAccountStart =
  | { kind: "ready"; emailState: string; mailboxState: string; folders: JmapRemoteFolder[] }
  /** A state moved during the snapshot; the caller retries on its next run. */
  | { kind: "changed" };

/** Start states and a folder snapshot that all carry the same mailbox state. Never retries. */
export async function readJmapAccountStart(
  session: JmapSession,
  authorization: string,
  accountId: string,
  signal: AbortSignal,
  deps: JmapTransportDependencies = {},
): Promise<JmapAccountStart> {
  requireMailAccount(session, accountId, signal);
  const emptyGet = (name: "Email/get" | "Mailbox/get") => readEmptyGetState(session, authorization, accountId, name, signal, deps);
  const emailState = await emptyGet("Email/get");
  const mailboxState = await emptyGet("Mailbox/get");
  // A mailbox destroyed after the query is a moved state for this snapshot, not an invalid response.
  const inventory = await readJmapMailboxInventory(session, authorization, accountId, signal, deps, mailboxState);
  if (inventory.kind === "changed") return { kind: "changed" };
  // A mailbox created after the last get would otherwise be missing from a snapshot labeled mailboxState.
  if ((await emptyGet("Mailbox/get")) !== mailboxState) return { kind: "changed" };
  const folders = mapJmapMailboxes(session, accountId, inventory.mailboxes);
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  return { kind: "ready", emailState, mailboxState, folders };
}
