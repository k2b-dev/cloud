import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import type { AccessSubject } from "@k2b/cloud/server";
import { sql } from "bun";
import type { SpaceItemResourceReferenceInput, User } from "../contracts";
import {
  type CalendarAddress,
  type CalendarAttendee,
  type CalendarInvitation,
  type CalendarInvitationPreviewInput,
  type CalendarInvitationResponse,
  type CalendarInvitationResponseCommitInput,
  type CalendarInvitationResponseInput,
  type CalendarInvitationResponseState,
  CalendarInvitationSchema,
  type CreateEventInvitationDraftInput,
  type EventInvitationContext,
  type EventInvitationDraft,
} from "../integration";
import { withShortId } from "../lib/short-id";
import { buildSpaceCalendarUid, buildSpaceItemHref } from "../routes";
import { getSpacePermission } from "./access";
import { publishSpaceEvent } from "./events";
import { ItemResourceReferenceLimitError, insertMany as insertItemResourceReferences } from "./item-resource-references";
import * as items from "./items";
import {
  createInvitationDraft as createMailInvitationDraft,
  listInvitationMailboxes,
  type MailIntegrationRequest,
} from "./mail-integration";

type ParsedProperty = { name: string; params: Record<string, string>; value: string };
type SqlExecutor = typeof sql;
type InternalCalendarInvitationExisting = {
  itemId: string;
  spaceId: string;
  href: string;
  sequence: number;
  method: CalendarInvitation["method"];
};
type InternalCalendarInvitationPreview = {
  invitation: CalendarInvitation;
  response: CalendarInvitationResponseState | null;
  existing: InternalCalendarInvitationExisting | null;
};
type InternalCalendarInvitationImportInput = CalendarInvitationPreviewInput & {
  spaceId: string;
  conversation: SpaceItemResourceReferenceInput;
};
type InternalCalendarInvitationImportResult = {
  itemId: string;
  spaceId: string;
  href: string;
  outcome: "created" | "updated" | "unchanged" | "cancelled";
};

const unfold = (source: string): string[] =>
  source
    .replace(/\r\n[ \t]/gu, "")
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

const parseProperty = (line: string): ParsedProperty | null => {
  let quoted = false;
  let separator = -1;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ":" && !quoted) {
      separator = index;
      break;
    }
  }
  if (separator < 1) return null;
  const [rawName, ...rawParams] = line.slice(0, separator).split(";");
  const name = rawName?.trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const equals = raw.indexOf("=");
    if (equals < 1) continue;
    params[raw.slice(0, equals).trim().toUpperCase()] = raw
      .slice(equals + 1)
      .trim()
      .replace(/^"|"$/gu, "");
  }
  return { name, params, value: line.slice(separator + 1) };
};

const decodeText = (value: string): string =>
  value.replace(/\\n/giu, "\n").replace(/\\,/gu, ",").replace(/\\;/gu, ";").replace(/\\\\/gu, "\\").trim();

const addressFromProperty = (property: ParsedProperty): CalendarAddress | null => {
  const address = property.value
    .replace(/^mailto:/iu, "")
    .trim()
    .toLowerCase();
  if (!address) return null;
  return { name: property.params.CN ? decodeText(property.params.CN) : null, address };
};

const partStat = (value: string | undefined): CalendarAttendee["participationStatus"] => {
  switch (value?.toUpperCase()) {
    case "ACCEPTED":
      return "accepted";
    case "TENTATIVE":
      return "tentative";
    case "DECLINED":
      return "declined";
    case "DELEGATED":
      return "delegated";
    case "NEEDS-ACTION":
      return "needs_action";
    default:
      return "unknown";
  }
};

const attendeeRole = (value: string | undefined): CalendarAttendee["role"] => {
  switch (value?.toUpperCase()) {
    case "REQ-PARTICIPANT":
      return "required";
    case "OPT-PARTICIPANT":
      return "optional";
    case "CHAIR":
      return "chair";
    default:
      return "unknown";
  }
};

const timezoneOffsetMs = (instant: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return (
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    ) - instant.getTime()
  );
};

const parseCalendarDate = (property: ParsedProperty): { iso: string; allDay: boolean } => {
  const value = property.value.trim();
  const dateOnly = property.params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/u.test(value);
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/u.exec(value);
  if (!match) throw new Error(`Unsupported calendar date: ${value.slice(0, 80)}`);
  const [, year, month, day, hour = "00", minute = "00", second = "00", utc] = match;
  const wallClock = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const normalized = new Date(wallClock);
  if (
    normalized.getUTCFullYear() !== Number(year) ||
    normalized.getUTCMonth() !== Number(month) - 1 ||
    normalized.getUTCDate() !== Number(day) ||
    normalized.getUTCHours() !== Number(hour) ||
    normalized.getUTCMinutes() !== Number(minute) ||
    normalized.getUTCSeconds() !== Number(second)
  ) {
    throw new Error(`Invalid calendar date: ${value.slice(0, 80)}`);
  }
  if (dateOnly || utc) return { iso: new Date(wallClock).toISOString(), allDay: dateOnly };
  const timeZone = property.params.TZID;
  if (!timeZone) return { iso: new Date(wallClock).toISOString(), allDay: false };
  let instant = new Date(wallClock);
  try {
    instant = new Date(wallClock - timezoneOffsetMs(instant, timeZone));
    instant = new Date(wallClock - timezoneOffsetMs(instant, timeZone));
  } catch {
    throw new Error(`Unsupported calendar time zone: ${timeZone}`);
  }
  return { iso: instant.toISOString(), allDay: false };
};

const methodValue = (value: string | undefined): CalendarInvitation["method"] => {
  const normalized = value?.toUpperCase();
  if (normalized === "REQUEST") return "request";
  if (normalized === "CANCEL") return "cancel";
  if (normalized === "REPLY") return "reply";
  if (normalized === "PUBLISH") return "publish";
  return "unknown";
};

export const parseCalendarInvitation = (source: string): Result<CalendarInvitation> => {
  try {
    if (Buffer.byteLength(source, "utf8") > 1_000_000) return fail(err.badInput("Calendar attachment is too large"));
    const properties = unfold(source)
      .map(parseProperty)
      .filter((value): value is ParsedProperty => Boolean(value));
    const eventStart = properties.findIndex((property) => property.name === "BEGIN" && property.value.toUpperCase() === "VEVENT");
    const eventEnd = properties.findIndex(
      (property, index) => index > eventStart && property.name === "END" && property.value.toUpperCase() === "VEVENT",
    );
    if (eventStart < 0 || eventEnd < 0) return fail(err.badInput("Calendar attachment contains no event"));
    const calendarProperties = properties.slice(0, eventStart);
    const event = properties.slice(eventStart + 1, eventEnd);
    const first = (name: string) => event.find((property) => property.name === name);
    const uid = decodeText(first("UID")?.value ?? "");
    const startProperty = first("DTSTART");
    if (!uid || !startProperty) return fail(err.badInput("Calendar event is missing UID or start time"));
    const start = parseCalendarDate(startProperty);
    const endProperty = first("DTEND");
    const durationEnd = new Date(new Date(start.iso).getTime() + (start.allDay ? 86_400_000 : 3_600_000)).toISOString();
    const end = endProperty ? parseCalendarDate(endProperty) : { iso: durationEnd, allDay: start.allDay };
    const organizerProperty = first("ORGANIZER");
    const attendees = event
      .filter((property) => property.name === "ATTENDEE")
      .map((property) => {
        const address = addressFromProperty(property);
        return address
          ? {
              ...address,
              participationStatus: partStat(property.params.PARTSTAT),
              role: attendeeRole(property.params.ROLE),
              responseRequested: property.params.RSVP?.toUpperCase() === "TRUE",
            }
          : null;
      })
      .filter((value): value is CalendarAttendee => Boolean(value));
    const rawUrl = decodeText(first("URL")?.value ?? "");
    const method = methodValue(calendarProperties.find((property) => property.name === "METHOD")?.value);
    if (method === "unknown") return fail(err.badInput("Calendar METHOD is missing or unsupported"));
    const parsed = CalendarInvitationSchema.safeParse({
      method,
      uid,
      sequence: Math.max(0, Number.parseInt(first("SEQUENCE")?.value ?? "0", 10) || 0),
      status:
        first("STATUS")?.value.toUpperCase() === "CANCELLED"
          ? "cancelled"
          : first("STATUS")?.value.toUpperCase() === "TENTATIVE"
            ? "tentative"
            : first("STATUS")?.value.toUpperCase() === "CONFIRMED"
              ? "confirmed"
              : "unknown",
      title: decodeText(first("SUMMARY")?.value ?? "Untitled event").slice(0, 200),
      description: decodeText(first("DESCRIPTION")?.value ?? "").slice(0, 5000) || null,
      location: decodeText(first("LOCATION")?.value ?? "").slice(0, 500) || null,
      url: rawUrl && URL.canParse(rawUrl) ? rawUrl : null,
      startsAt: start.iso,
      endsAt: end.iso,
      allDay: start.allDay,
      recurrenceRule: decodeText(first("RRULE")?.value ?? "").slice(0, 4096) || null,
      organizer: organizerProperty ? addressFromProperty(organizerProperty) : null,
      attendees,
    });
    if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid calendar event"));
    if (new Date(parsed.data.endsAt).getTime() <= new Date(parsed.data.startsAt).getTime()) {
      return fail(err.badInput("Calendar event must end after it starts"));
    }
    return ok(parsed.data);
  } catch (error) {
    return fail(err.badInput(error instanceof Error ? error.message : "Invalid calendar attachment"));
  }
};

const publicEventRef = async (itemId: string, db: SqlExecutor = sql): Promise<{ spaceId: string; itemId: string } | null> => {
  const [row] = await db<{ space_id: string; item_id: string }[]>`
    SELECT space.short_id AS space_id, item.short_id AS item_id
    FROM spaces.items item
    JOIN spaces.spaces space ON space.id = item.space_id
    WHERE item.id = ${itemId}::uuid
  `;
  return row ? { spaceId: row.space_id, itemId: row.item_id } : null;
};
const calendarSourceLockKey = (mailboxId: string, uid: string) => `spaces:calendar-invitation:${mailboxId}:${uid}`;
const calendarItemLockKey = (itemId: string) => `spaces:calendar-invitation-item:${itemId}`;

const findExisting = async (mailboxId: string, uid: string, db: SqlExecutor = sql, lock = false) => {
  const [row] = await db<
    {
      item_id: string;
      space_id: string;
      item_short_id: string;
      space_short_id: string;
      sequence: number;
      method: CalendarInvitation["method"];
      message_id: string | null;
      last_response: CalendarInvitationResponseState | string | null;
    }[]
  >`
    SELECT source.item_id, item.space_id, item.short_id AS item_short_id, space.short_id AS space_short_id,
           source.sequence, source.method, source.message_id, source.last_response
    FROM spaces.calendar_invitation_sources source
    JOIN spaces.items item ON item.id = source.item_id
    JOIN spaces.spaces space ON space.id = item.space_id
    WHERE source.mailbox_id = ${mailboxId} AND source.calendar_uid = ${uid}
    ${lock ? sql`FOR UPDATE OF source` : sql``}
  `;
  if (!row) return null;
  const response = row.last_response
    ? typeof row.last_response === "string"
      ? (JSON.parse(row.last_response) as CalendarInvitationResponseState)
      : row.last_response
    : null;
  return {
    itemId: row.item_id,
    spaceId: row.space_id,
    sequence: row.sequence,
    method: row.method,
    messageId: row.message_id,
    href: buildSpaceItemHref(row.space_short_id, row.item_short_id),
    response,
  };
};

const lockCalendarSourceForItem = async (
  db: SqlExecutor,
  itemId: string,
  target?: { mailboxId: string; calendarUid: string },
): Promise<boolean> => {
  const [observed] = await db<{ mailbox_id: string; calendar_uid: string }[]>`
    SELECT mailbox_id, calendar_uid
    FROM spaces.calendar_invitation_sources
    WHERE item_id = ${itemId}::uuid
  `;
  const sourceLockKeys = new Set<string>();
  if (observed) sourceLockKeys.add(calendarSourceLockKey(observed.mailbox_id, observed.calendar_uid));
  if (target) sourceLockKeys.add(calendarSourceLockKey(target.mailboxId, target.calendarUid));
  for (const lockKey of [...sourceLockKeys].sort()) {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  }
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${calendarItemLockKey(itemId)}, 0))`;
  const [current] = await db<{ mailbox_id: string; calendar_uid: string }[]>`
    SELECT mailbox_id, calendar_uid
    FROM spaces.calendar_invitation_sources
    WHERE item_id = ${itemId}::uuid
    FOR UPDATE
  `;
  const unchanged = observed
    ? current?.mailbox_id === observed.mailbox_id && current.calendar_uid === observed.calendar_uid
    : current === undefined;
  if (!unchanged || !target) return unchanged;
  const [targetSource] = await db<{ item_id: string }[]>`
    SELECT item_id
    FROM spaces.calendar_invitation_sources
    WHERE mailbox_id = ${target.mailboxId} AND calendar_uid = ${target.calendarUid}
    FOR UPDATE
  `;
  return !targetSource || targetSource.item_id === itemId;
};

export const previewCalendarInvitation = async (
  input: CalendarInvitationPreviewInput,
): Promise<Result<InternalCalendarInvitationPreview>> => {
  const parsed = parseCalendarInvitation(input.calendar);
  if (!parsed.ok) return parsed;
  const existing = await findExisting(input.mailboxId, parsed.data.uid);
  if (!existing) return ok({ invitation: parsed.data, existing: null, response: null });
  const { response, messageId: _messageId, ...existingProjection } = existing;
  return ok({ invitation: parsed.data, existing: existingProjection, response });
};

export const getCalendarResponseCommitContext = async (params: {
  input: CalendarInvitationResponseCommitInput;
  subject: AccessSubject;
}): Promise<Result<{ itemId: string; spaceId: string; title: string }>> => {
  const [source] = await sql<{ item_id: string; space_id: string }[]>`
    SELECT source.item_id, item.space_id
    FROM spaces.calendar_invitation_sources source
    JOIN spaces.items item ON item.id = source.item_id
    WHERE source.mailbox_id = ${params.input.mailboxId}
      AND source.message_id = ${params.input.messageId}
  `;
  if (!source) return fail(err.badInput("Add this invitation to Spaces before responding"));
  const permission = await getSpacePermission({ spaceId: source.space_id, subject: params.subject });
  if (permission !== "write" && permission !== "admin") return fail(err.badInput("Add this invitation to Spaces before responding"));
  const item = await items.get({ id: source.item_id });
  return item ? ok({ itemId: item.id, spaceId: source.space_id, title: item.title }) : fail(err.notFound("Event"));
};

export const commitCalendarResponse = async (params: {
  input: CalendarInvitationResponseCommitInput;
  subject: AccessSubject;
}): Promise<Result<CalendarInvitationResponseState>> => {
  const source = await getCalendarResponseCommitContext(params);
  if (!source.ok) return source;
  const state: CalendarInvitationResponseState = {
    participationStatus: params.input.participationStatus,
    state: "drafted",
    draftId: params.input.draftId,
    updatedAt: new Date().toISOString(),
  };
  return sql.begin(async (tx) => {
    if (!(await lockCalendarSourceForItem(tx, source.data.itemId))) {
      return fail(err.conflict("Calendar invitation linkage changed concurrently"));
    }
    const [current] = await tx<{ item_id: string }[]>`
      SELECT item_id
      FROM spaces.calendar_invitation_sources
      WHERE item_id = ${source.data.itemId}::uuid
        AND mailbox_id = ${params.input.mailboxId}
        AND message_id = ${params.input.messageId}
      FOR UPDATE
    `;
    if (!current) return fail(err.badInput("Add this invitation to Spaces before responding"));
    await tx`
      UPDATE spaces.calendar_invitation_sources
      SET last_response = ${state}::jsonb, updated_at = now()
      WHERE item_id = ${current.item_id}::uuid
    `;
    return ok(state);
  });
};

export const decideCalendarImport = (params: {
  existing: { sequence: number; method: CalendarInvitation["method"] } | null;
  invitation: Pick<CalendarInvitation, "sequence" | "method" | "status">;
}): "create" | "apply" | "unchanged" | "reject_cancellation" => {
  const cancelled = params.invitation.method === "cancel" || params.invitation.status === "cancelled";
  if (!params.existing) return cancelled ? "reject_cancellation" : "create";
  if (params.existing.sequence > params.invitation.sequence) return "unchanged";
  if (params.existing.sequence === params.invitation.sequence && params.existing.method === params.invitation.method) return "unchanged";
  return "apply";
};

const importParsedCalendarInvitation = async (params: {
  input: InternalCalendarInvitationImportInput;
  invitation: CalendarInvitation;
  user: User;
  subject: AccessSubject;
}): Promise<Result<InternalCalendarInvitationImportResult>> => {
  const { invitation } = params;
  const permission = await getSpacePermission({ spaceId: params.input.spaceId, subject: params.subject });
  if (permission !== "write" && permission !== "admin") return fail(err.forbidden("Write access to the destination Space is required"));
  let result: Result<InternalCalendarInvitationImportResult>;
  try {
    result = await withShortId("item", (shortId) =>
      sql.begin(async (tx): Promise<Result<InternalCalendarInvitationImportResult>> => {
        await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${calendarSourceLockKey(params.input.mailboxId, invitation.uid)}, 0)
      )
    `;
        let existing = await findExisting(params.input.mailboxId, invitation.uid, tx, true);
        if (existing) {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${calendarItemLockKey(existing.itemId)}, 0))`;
          const current = await findExisting(params.input.mailboxId, invitation.uid, tx, true);
          if (!current || current.itemId !== existing.itemId) return fail(err.conflict("Calendar invitation linkage changed concurrently"));
          existing = current;
        }
        if (existing && existing.spaceId !== params.input.spaceId) {
          return fail(err.conflict("This calendar event is already linked to another Space"));
        }
        const decision = decideCalendarImport({ existing, invitation });
        if (existing && decision === "unchanged") {
          await insertItemResourceReferences(tx, existing.itemId, [params.input.conversation]);
          return ok({ itemId: existing.itemId, spaceId: existing.spaceId, href: existing.href, outcome: "unchanged" });
        }
        const cancelled = invitation.method === "cancel" || invitation.status === "cancelled";
        if (decision === "reject_cancellation") return fail(err.badInput("A cancellation cannot create a new event"));
        const persisted = await items.persistCalendarEvent({
          db: tx,
          spaceId: params.input.spaceId,
          itemId: existing?.itemId ?? null,
          createdBy: params.user.id,
          completed: cancelled,
          shortId,
          data: {
            title: invitation.title,
            description: invitation.description,
            location: invitation.location,
            url: invitation.url,
            startsAt: invitation.startsAt,
            endsAt: invitation.endsAt,
            allDay: invitation.allDay,
            recurrenceRule: invitation.recurrenceRule,
          },
        });
        if (!persisted.ok) {
          return fail(
            persisted.status === 404
              ? err.notFound(persisted.error)
              : persisted.status === 500
                ? err.internal(persisted.error)
                : err.badInput(persisted.error),
          );
        }
        if (existing) {
          await tx`
        UPDATE spaces.calendar_invitation_sources
        SET message_id = ${params.input.messageId}, sequence = ${invitation.sequence}, method = ${invitation.method},
            organizer = ${invitation.organizer}::jsonb, attendees = ${invitation.attendees}::jsonb,
            last_response = NULL, updated_at = now()
        WHERE item_id = ${existing.itemId}::uuid
      `;
          await insertItemResourceReferences(tx, existing.itemId, [params.input.conversation]);
          return ok({
            itemId: existing.itemId,
            spaceId: existing.spaceId,
            href: existing.href,
            outcome: cancelled ? "cancelled" : "updated",
          });
        }
        await tx`
      INSERT INTO spaces.calendar_invitation_sources (
        item_id, mailbox_id, message_id, calendar_uid, sequence, method, organizer, attendees
      ) VALUES (
        ${persisted.data.id}::uuid, ${params.input.mailboxId}, ${params.input.messageId}, ${invitation.uid},
        ${invitation.sequence}, ${invitation.method}, ${invitation.organizer}::jsonb, ${invitation.attendees}::jsonb
      )
    `;
        const publicRef = await publicEventRef(persisted.data.id, tx);
        if (!publicRef) return fail(err.internal("Created calendar event has no public ID"));
        await insertItemResourceReferences(tx, persisted.data.id, [params.input.conversation]);
        return ok({
          itemId: persisted.data.id,
          spaceId: params.input.spaceId,
          href: buildSpaceItemHref(publicRef.spaceId, publicRef.itemId),
          outcome: "created",
        });
      }),
    );
  } catch (error) {
    if (error instanceof ItemResourceReferenceLimitError) {
      return fail(err.conflict("Space item already has the maximum number of linked resources"));
    }
    throw error;
  }
  if (!result.ok) return result;
  if (result.data.outcome === "created") {
    await publishSpaceEvent({ type: "item.created", spaceId: result.data.spaceId, itemId: result.data.itemId });
  } else {
    await publishSpaceEvent({ type: "item.updated", spaceId: result.data.spaceId, itemId: result.data.itemId });
    if (result.data.outcome === "cancelled") {
      await publishSpaceEvent({ type: "item.completed", spaceId: result.data.spaceId, itemId: result.data.itemId });
    }
  }
  return result;
};

export const importCalendarInvitation = async (params: {
  input: InternalCalendarInvitationImportInput;
  user: User;
  subject: AccessSubject;
}): Promise<Result<InternalCalendarInvitationImportResult>> => {
  const invitation = parseCalendarInvitation(params.input.calendar);
  if (!invitation.ok) return invitation;
  return importParsedCalendarInvitation({ ...params, invitation: invitation.data });
};

const escapeText = (value: string) => value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/,/gu, "\\,").replace(/;/gu, "\\;");
const foldLine = (line: string) => line.match(/.{1,73}/gu)?.join("\r\n ") ?? line;
const icalDate = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");

export const buildCalendarResponse = (input: CalendarInvitationResponseInput): Result<CalendarInvitationResponse> => {
  const parsed = parseCalendarInvitation(input.calendar);
  if (!parsed.ok) return parsed;
  const invitation = parsed.data;
  if (!invitation.organizer) return fail(err.badInput("The invitation has no organizer address"));
  const partstat =
    input.participationStatus === "accepted" ? "ACCEPTED" : input.participationStatus === "tentative" ? "TENTATIVE" : "DECLINED";
  const label =
    input.participationStatus === "accepted" ? "Accepted" : input.participationStatus === "tentative" ? "Tentative" : "Declined";
  const attendee = `ATTENDEE;PARTSTAT=${partstat}${input.attendee.name ? `;CN=${escapeText(input.attendee.name)}` : ""}:mailto:${input.attendee.address}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cloud Spaces//Calendar response//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${escapeText(invitation.uid)}`,
    `SEQUENCE:${invitation.sequence}`,
    `DTSTAMP:${icalDate(new Date().toISOString())}`,
    `DTSTART:${icalDate(invitation.startsAt)}`,
    `DTEND:${icalDate(invitation.endsAt)}`,
    `SUMMARY:${escapeText(invitation.title)}`,
    attendee,
    `ORGANIZER:mailto:${invitation.organizer.address}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return ok({
    to: invitation.organizer,
    subject: `${label}: ${invitation.title}`,
    body: `${input.attendee.name ?? input.attendee.address} responded ${label.toLowerCase()} to “${invitation.title}”.`,
    calendar: `${lines.map(foldLine).join("\r\n")}\r\n`,
  });
};

export const prepareCalendarResponse = async (params: {
  input: CalendarInvitationResponseInput;
  subject: AccessSubject;
}): Promise<Result<CalendarInvitationResponse>> => {
  const parsed = parseCalendarInvitation(params.input.calendar);
  if (!parsed.ok) return parsed;
  const existing = await findExisting(params.input.mailboxId, parsed.data.uid);
  if (!existing) return fail(err.badInput("Add this invitation to Spaces before responding"));
  const permission = await getSpacePermission({ spaceId: existing.spaceId, subject: params.subject });
  if (permission !== "write" && permission !== "admin") return fail(err.badInput("Add this invitation to Spaces before responding"));
  if (existing.sequence !== parsed.data.sequence || existing.messageId !== params.input.messageId) {
    return fail(err.conflict("A newer invitation is already linked in Spaces"));
  }
  return buildCalendarResponse(params.input);
};

const requireWritableEvent = async (params: { spaceId: string; itemId: string; subject: AccessSubject }) => {
  const permission = await getSpacePermission({ spaceId: params.spaceId, subject: params.subject });
  if (permission !== "write" && permission !== "admin") return fail(err.forbidden("Write access to this Space is required"));
  const item = await items.get({ id: params.itemId });
  if (!item || item.spaceId !== params.spaceId) return fail(err.notFound("Event"));
  if (!item.startsAt || !item.endsAt) return fail(err.badInput("Calendar invitations require an event with a start and end time"));
  return ok(item);
};

const normalizeAttendees = (attendees: CalendarAddress[], organizerAddress: string): CalendarAddress[] => {
  const organizer = organizerAddress.trim().toLowerCase();
  const unique = new Map<string, CalendarAddress>();
  for (const attendee of attendees) {
    const address = attendee.address.trim().toLowerCase();
    if (!address || address === organizer || unique.has(address)) continue;
    unique.set(address, { name: attendee.name?.trim() || null, address });
  }
  return [...unique.values()];
};

const invitationDate = (value: string, allDay: boolean): string => {
  const date = new Date(value);
  return allDay
    ? date.toISOString().slice(0, 10).replace(/-/gu, "")
    : date
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}Z$/u, "Z");
};

const buildEventInvitation = (params: {
  item: NonNullable<Awaited<ReturnType<typeof items.get>>>;
  uid: string;
  sequence: number;
  method: "request" | "cancel";
  organizer: CalendarAddress;
  attendees: CalendarAddress[];
  generatedAt?: string;
}): string => {
  const event = params.item;
  const method = params.method.toUpperCase();
  const dateParameter = event.allDay ? ";VALUE=DATE" : "";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cloud Spaces//Event invitation//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${escapeText(params.uid)}`,
    `SEQUENCE:${params.sequence}`,
    `DTSTAMP:${icalDate(params.generatedAt ?? new Date().toISOString())}`,
    `DTSTART${dateParameter}:${invitationDate(event.startsAt!, event.allDay)}`,
    `DTEND${dateParameter}:${invitationDate(event.endsAt!, event.allDay)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.url ? [`URL:${event.url}`] : []),
    ...(event.recurrence?.rrule ? [`RRULE:${event.recurrence.rrule}`] : []),
    `ORGANIZER${params.organizer.name ? `;CN=${escapeText(params.organizer.name)}` : ""}:mailto:${params.organizer.address}`,
    ...params.attendees.map(
      (attendee) =>
        `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${attendee.name ? `;CN=${escapeText(attendee.name)}` : ""}:mailto:${attendee.address}`,
    ),
    ...(params.method === "cancel" ? ["STATUS:CANCELLED"] : ["STATUS:CONFIRMED"]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
};

export type PreparedEventInvitationAttachment = {
  deliveryId: string;
  itemId: string;
  mailboxId: string;
  draftId: string;
  sequence: number;
  filename: string;
  contentType: string;
  calendar: string;
};

export const prepareEventInvitationAttachment = async (params: {
  spaceId: string;
  itemId: string;
  subject: AccessSubject;
  deliveryId: string;
  mailboxId: string;
  draftId: string;
  senderIdentityId: string;
  organizer: CalendarAddress;
  attendees: CalendarAddress[];
}): Promise<Result<PreparedEventInvitationAttachment>> => {
  const item = await requireWritableEvent(params);
  if (!item.ok) return item;
  const organizer: CalendarAddress = {
    name: params.organizer.name?.trim() || null,
    address: params.organizer.address.trim().toLowerCase(),
  };
  const attendees = normalizeAttendees(params.attendees, organizer.address);
  if (attendees.length === 0) return fail(err.badInput("Add at least one To or Cc recipient other than the organizer"));
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        itemId: params.itemId,
        mailboxId: params.mailboxId,
        draftId: params.draftId,
        senderIdentityId: params.senderIdentityId,
        organizer,
        attendees,
      }),
    )
    .digest("hex");
  const filename = "invitation.ics";
  const contentType = "text/calendar; method=REQUEST; charset=utf-8";
  const publicRef = await publicEventRef(params.itemId);
  if (!publicRef) return fail(err.notFound("Event"));
  const uid = buildSpaceCalendarUid(publicRef.itemId);

  return sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`spaces:event-invitation:${params.deliveryId}`}, 0)
      )
    `;
    const [existing] = await tx<
      {
        item_id: string;
        mailbox_id: string;
        draft_id: string | null;
        request_fingerprint: string | null;
        sequence: number;
        calendar_payload: string | null;
        attachment_filename: string | null;
      }[]
    >`
      SELECT item_id, mailbox_id, draft_id, request_fingerprint, sequence, calendar_payload, attachment_filename
      FROM spaces.calendar_invitation_deliveries
      WHERE idempotency_key = ${params.deliveryId}::uuid
      FOR UPDATE
    `;
    if (existing) {
      if (
        existing.item_id !== params.itemId ||
        existing.mailbox_id !== params.mailboxId ||
        existing.draft_id !== params.draftId ||
        existing.request_fingerprint !== requestFingerprint
      ) {
        return fail(capabilityIdempotencyConflict("Invitation idempotency key belongs to another request"));
      }
      if (!existing.calendar_payload || !existing.attachment_filename) {
        return fail(err.conflict("Invitation preparation is incomplete; use a new idempotency key"));
      }
      return ok({
        deliveryId: params.deliveryId,
        itemId: params.itemId,
        mailboxId: params.mailboxId,
        draftId: params.draftId,
        sequence: existing.sequence,
        filename: existing.attachment_filename,
        contentType,
        calendar: existing.calendar_payload,
      });
    }

    if (!(await lockCalendarSourceForItem(tx, params.itemId, { mailboxId: params.mailboxId, calendarUid: uid }))) {
      return fail(err.conflict("Calendar invitation linkage changed concurrently"));
    }
    const [insertedSource] = await tx<{ sequence: number }[]>`
      INSERT INTO spaces.calendar_invitation_sources (
        item_id, mailbox_id, message_id, calendar_uid, sequence, method, organizer, attendees
      ) VALUES (
        ${params.itemId}::uuid, ${params.mailboxId}, NULL, ${uid}, 0, 'request',
        ${organizer}::jsonb, ${attendees}::jsonb
      )
      ON CONFLICT (item_id) DO NOTHING
      RETURNING sequence
    `;
    let sequence = insertedSource?.sequence ?? 0;
    if (!insertedSource) {
      const [source] = await tx<{ sequence: number }[]>`
        SELECT sequence
        FROM spaces.calendar_invitation_sources
        WHERE item_id = ${params.itemId}::uuid
        FOR UPDATE
      `;
      if (!source) return fail(err.internal("Invitation source could not be reserved"));
      sequence = source.sequence + 1;
      await tx`
        UPDATE spaces.calendar_invitation_sources
        SET mailbox_id = ${params.mailboxId},
            calendar_uid = ${uid},
            sequence = ${sequence},
            method = 'request',
            organizer = ${organizer}::jsonb,
            attendees = ${attendees}::jsonb,
            updated_at = now()
        WHERE item_id = ${params.itemId}::uuid
      `;
    }
    const calendar = buildEventInvitation({
      item: item.data,
      uid,
      sequence,
      method: "request",
      organizer,
      attendees,
      generatedAt: new Date().toISOString(),
    });
    await tx`
      INSERT INTO spaces.calendar_invitation_deliveries (
        idempotency_key, item_id, mailbox_id, sender_identity_id, sequence, method, state,
        draft_id, request_fingerprint, calendar_payload, attachment_filename
      ) VALUES (
        ${params.deliveryId}::uuid, ${params.itemId}::uuid, ${params.mailboxId},
        ${params.senderIdentityId}, ${sequence}, 'request', 'prepared', ${params.draftId},
        ${requestFingerprint}, ${calendar}, ${filename}
      )
    `;
    return ok({
      deliveryId: params.deliveryId,
      itemId: params.itemId,
      mailboxId: params.mailboxId,
      draftId: params.draftId,
      sequence,
      filename,
      contentType,
      calendar,
    });
  });
};

export const getEventInvitationCommitContext = async (params: {
  deliveryId: string;
  subject: AccessSubject;
}): Promise<Result<{ deliveryId: string; itemId: string; spaceId: string; draftId: string; title: string }>> => {
  const [delivery] = await sql<{ item_id: string; draft_id: string | null }[]>`
    SELECT item_id, draft_id
    FROM spaces.calendar_invitation_deliveries
    WHERE idempotency_key = ${params.deliveryId}::uuid
  `;
  if (!delivery?.draft_id) return fail(err.notFound("Prepared invitation"));
  const item = await items.get({ id: delivery.item_id });
  if (!item) return fail(err.notFound("Event"));
  const writable = await requireWritableEvent({ spaceId: item.spaceId, itemId: item.id, subject: params.subject });
  return writable.ok
    ? ok({ deliveryId: params.deliveryId, itemId: item.id, spaceId: item.spaceId, draftId: delivery.draft_id, title: item.title })
    : writable;
};

export const commitEventInvitationAttachment = async (params: {
  deliveryId: string;
  subject: AccessSubject;
}): Promise<Result<{ deliveryId: string; itemId: string; draftId: string; state: "drafted" }>> => {
  const delivery = await getEventInvitationCommitContext(params);
  if (!delivery.ok) return delivery;
  const [updated] = await sql<{ item_id: string; draft_id: string }[]>`
    UPDATE spaces.calendar_invitation_deliveries
    SET state = 'drafted', error_message = NULL, updated_at = now()
    WHERE idempotency_key = ${params.deliveryId}::uuid
      AND state IN ('prepared', 'drafted')
      AND draft_id IS NOT NULL
    RETURNING item_id, draft_id
  `;
  if (!updated) return fail(err.conflict("Invitation is not ready to commit"));
  return ok({ deliveryId: params.deliveryId, itemId: updated.item_id, draftId: updated.draft_id, state: "drafted" });
};

export const getEventInvitationContext = async (params: {
  spaceId: string;
  itemId: string;
  subject: AccessSubject;
  request: MailIntegrationRequest;
}): Promise<Result<EventInvitationContext>> => {
  const item = await requireWritableEvent(params);
  if (!item.ok) return item;
  const mailboxes = await listInvitationMailboxes(params.request);
  if (!mailboxes.ok) return fail(err.internal(mailboxes.message));
  const [source] = await sql<{ attendees: CalendarAddress[] | string; method: string }[]>`
    SELECT attendees, method FROM spaces.calendar_invitation_sources WHERE item_id = ${params.itemId}::uuid
  `;
  const [delivery] = await sql<
    {
      sequence: number;
      method: "request" | "cancel";
      state: "preparing" | "prepared" | "drafted" | "failed";
      draft_id: string | null;
      error_message: string | null;
      updated_at: Date | string;
    }[]
  >`
    SELECT sequence, method, state, draft_id, error_message, updated_at
    FROM spaces.calendar_invitation_deliveries
    WHERE item_id = ${params.itemId}::uuid
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;
  const attendees = source
    ? typeof source.attendees === "string"
      ? (JSON.parse(source.attendees) as CalendarAddress[])
      : source.attendees
    : [];
  return ok({
    mailboxes: mailboxes.data,
    attendees,
    canCancel: Boolean(source && source.method !== "cancel"),
    lastDelivery: delivery
      ? {
          sequence: delivery.sequence,
          method: delivery.method,
          state: delivery.state,
          draftId: delivery.draft_id,
          errorMessage: delivery.error_message,
          updatedAt: new Date(delivery.updated_at).toISOString(),
        }
      : null,
  });
};

export const createEventInvitationDraft = async (params: {
  spaceId: string;
  itemId: string;
  subject: AccessSubject;
  input: CreateEventInvitationDraftInput;
  request: MailIntegrationRequest;
}): Promise<Result<EventInvitationDraft>> => {
  const item = await requireWritableEvent(params);
  if (!item.ok) return item;
  const mailboxes = await listInvitationMailboxes(params.request);
  if (!mailboxes.ok) return fail(err.internal(mailboxes.message));
  const mailbox = mailboxes.data.find((candidate) => candidate.id === params.input.mailboxId);
  if (!mailbox) return fail(err.forbidden("The selected mailbox cannot send invitations"));
  const identity = mailbox.identities.find((candidate) => candidate.id === params.input.senderIdentityId);
  if (!identity) return fail(err.forbidden("The selected verified sender identity is unavailable"));
  const attendees = normalizeAttendees(params.input.attendees, identity.from.address);
  if (attendees.length === 0) return fail(err.badInput("Add at least one attendee other than the organizer"));
  const publicRef = await publicEventRef(params.itemId);
  if (!publicRef) return fail(err.notFound("Event"));
  const uid = buildSpaceCalendarUid(publicRef.itemId);

  const prepared = await sql.begin(async (tx) => {
    const [delivery] = await tx<
      {
        item_id: string;
        mailbox_id: string;
        sender_identity_id: string | null;
        sequence: number;
        method: "request" | "cancel";
        state: "preparing" | "prepared" | "drafted" | "failed";
        draft_id: string | null;
      }[]
    >`
      SELECT item_id, mailbox_id, sender_identity_id, sequence, method, state, draft_id
      FROM spaces.calendar_invitation_deliveries
      WHERE idempotency_key = ${params.input.idempotencyKey}::uuid
      FOR UPDATE
    `;
    if (delivery) {
      if (
        delivery.item_id !== params.itemId ||
        delivery.mailbox_id !== mailbox.id ||
        (delivery.sender_identity_id !== null && delivery.sender_identity_id !== identity.id) ||
        delivery.method !== params.input.method
      ) {
        return fail(capabilityIdempotencyConflict("Invitation idempotency key belongs to another request"));
      }
      if (delivery.state === "drafted" && delivery.draft_id) {
        return ok({ sequence: delivery.sequence, draftId: delivery.draft_id, alreadyDrafted: true });
      }
      await tx`
        UPDATE spaces.calendar_invitation_deliveries
        SET state = 'preparing', error_message = NULL, updated_at = now()
        WHERE idempotency_key = ${params.input.idempotencyKey}::uuid
      `;
      return ok({ sequence: delivery.sequence, draftId: null, alreadyDrafted: false });
    }
    if (!(await lockCalendarSourceForItem(tx, params.itemId, { mailboxId: mailbox.id, calendarUid: uid }))) {
      return fail(err.conflict("Calendar invitation linkage changed concurrently"));
    }
    const [source] = await tx<{ sequence: number }[]>`
      SELECT sequence FROM spaces.calendar_invitation_sources WHERE item_id = ${params.itemId}::uuid FOR UPDATE
    `;
    if (!source && params.input.method === "cancel") {
      return fail(err.badInput("No invitation has been created for this event yet"));
    }
    const sequence = source ? source.sequence + 1 : 0;
    await tx`
      INSERT INTO spaces.calendar_invitation_sources (
        item_id, mailbox_id, message_id, calendar_uid, sequence, method, organizer, attendees
      ) VALUES (
        ${params.itemId}::uuid, ${mailbox.id}, NULL, ${uid}, ${sequence}, ${params.input.method},
        ${identity.from}::jsonb, ${attendees}::jsonb
      )
      ON CONFLICT (item_id) DO UPDATE SET
        mailbox_id = EXCLUDED.mailbox_id,
        calendar_uid = EXCLUDED.calendar_uid,
        sequence = EXCLUDED.sequence,
        method = EXCLUDED.method,
        organizer = EXCLUDED.organizer,
        attendees = EXCLUDED.attendees,
        updated_at = now()
    `;
    await tx`
      INSERT INTO spaces.calendar_invitation_deliveries (
        idempotency_key, item_id, mailbox_id, sender_identity_id, sequence, method, state
      ) VALUES (
        ${params.input.idempotencyKey}::uuid, ${params.itemId}::uuid, ${mailbox.id}, ${identity.id},
        ${sequence}, ${params.input.method}, 'preparing'
      )
    `;
    return ok({ sequence, draftId: null, alreadyDrafted: false });
  });
  if (!prepared.ok) return prepared;
  const hrefFor = (draftId: string) => `/app/mail/${mailbox.id}/compose/${draftId}`;
  if (prepared.data.alreadyDrafted && prepared.data.draftId) {
    return ok({
      mailboxId: mailbox.id,
      draftId: prepared.data.draftId,
      href: hrefFor(prepared.data.draftId),
      sequence: prepared.data.sequence,
      method: params.input.method,
    });
  }

  const calendar = buildEventInvitation({
    item: item.data,
    uid,
    sequence: prepared.data.sequence,
    method: params.input.method,
    organizer: identity.from,
    attendees,
  });
  const label = params.input.method === "cancel" ? "Cancelled" : prepared.data.sequence === 0 ? "Invitation" : "Updated invitation";
  const mail = await createMailInvitationDraft(
    {
      idempotencyKey: params.input.idempotencyKey,
      mailboxId: mailbox.id,
      senderIdentityId: identity.id,
      to: attendees,
      subject: `${label}: ${item.data.title}`,
      body:
        params.input.method === "cancel"
          ? `The event “${item.data.title}” has been cancelled.`
          : `You are invited to “${item.data.title}”. Open the attached calendar invitation for the full event details.`,
      calendar,
    },
    params.request,
  );
  if (!mail.ok) {
    await sql`
      UPDATE spaces.calendar_invitation_deliveries
      SET state = 'failed', error_message = ${mail.message}, updated_at = now()
      WHERE idempotency_key = ${params.input.idempotencyKey}::uuid
    `;
    return fail(err.internal(mail.message));
  }
  await sql`
    UPDATE spaces.calendar_invitation_deliveries
    SET state = 'drafted', draft_id = ${mail.data.draftId}, updated_at = now()
    WHERE idempotency_key = ${params.input.idempotencyKey}::uuid
  `;
  return ok({
    ...mail.data,
    href: hrefFor(mail.data.draftId),
    sequence: prepared.data.sequence,
    method: params.input.method,
  });
};
