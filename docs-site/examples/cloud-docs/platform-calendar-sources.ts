import { createHash } from "node:crypto";
import { defineCapabilities } from "@k2b/cloud";
import { type CapabilityCaller, listCalendarSources, readCalendarEvents } from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CalendarEventsDataSchema,
  CalendarEventsInputSchema,
  type CalendarItem,
  CalendarListDataSchema,
  CalendarListInputSchema,
  type CapabilityExecutionContext,
  calendarSourceIssues,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";

// Example data only. A deployed app reads its own authorized absence records from its database.
const absences = [{ id: "leave-1", ownerId: "user-42", title: "Annual leave", start: "2026-11-02", end: "2026-11-07", revision: "1" }];
const callerId = (context: CapabilityExecutionContext) => {
  const userBacked = context.actor.kind === "user" || context.actor.serviceAccount.kind === "user_delegated";
  return userBacked && context.user && context.accessSubject.type === "user" && context.user.id === context.accessSubject.userId
    ? context.user.id
    : null;
};
const cursorSchema = z.object({ scope: z.string(), offset: z.number().int().nonnegative() }).strict();
export const absenceCapabilities = defineCapabilities({
  protocolVersion: 2,
  calendarSource: { calendars: "calendar.list", events: "calendar.events" },
  queries: {
    "calendar.list": {
      title: "List absence calendars",
      description: "Offer the current person's own absence calendar.",
      input: CalendarListInputSchema,
      data: CalendarListDataSchema,
      openWorld: false,
      run: async (input, context) => {
        if (!callerId(context)) return fail(err.forbidden("A user-backed actor is required"));
        if (input.cursor) return fail(err.badInput("This calendar list has no continuation"));
        return ok({
          data: {
            items: [
              {
                id: "mine",
                name: "My absences",
                color: "#0f766e",
                suggested: true,
                visibility: "details" as const,
                writable: false,
                open: { rel: "open" as const, href: "/app/absence?view=calendar" },
              },
            ],
            next: null,
          },
        });
      },
    },
    "calendar.events": {
      title: "Read absences",
      description: "Read the current person's absence dates in a half-open UTC range.",
      input: CalendarEventsInputSchema,
      data: CalendarEventsDataSchema,
      openWorld: false,
      run: async (input, context) => {
        const userId = callerId(context);
        if (!userId) return fail(err.forbidden("A user-backed actor is required"));
        const limit = input.limit ?? 100;
        const scope = createHash("sha256")
          .update(JSON.stringify([userId, input.calendarIds, input.from, input.to, limit]))
          .digest("hex");
        let offset = 0;
        if (input.cursor) {
          try {
            const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
            if (cursor.scope !== scope) throw new Error();
            offset = cursor.offset;
          } catch {
            return fail(err.badInput("Invalid calendar cursor"));
          }
        }
        const matches = absences
          .filter(
            (row) =>
              row.ownerId === userId &&
              input.calendarIds.includes("mine") &&
              Date.parse(`${row.start}T00:00:00Z`) < Date.parse(input.to) &&
              Date.parse(`${row.end}T00:00:00Z`) > Date.parse(input.from),
          )
          .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
        const items: CalendarItem[] = matches.slice(offset, offset + limit).map((row) => ({
          type: "event",
          id: row.id,
          calendarId: "mine",
          title: row.title,
          time: { kind: "date", start: row.start, end: row.end },
          location: null,
          status: "confirmed",
          transparency: "busy",
          occurrence: null,
          ref: null,
          open: { rel: "open", href: `/app/absence?item=${encodeURIComponent(row.id)}` },
          version: row.revision,
        }));
        const nextOffset = offset + items.length;
        return ok({
          data: {
            items,
            next: nextOffset < matches.length ? Buffer.from(JSON.stringify({ scope, offset: nextOffset })).toString("base64url") : null,
          },
        });
      },
    },
  },
});
export const absenceManifest = compileCapabilityManifest("absence", absenceCapabilities);
if (calendarSourceIssues(absenceManifest).length) throw new Error("Invalid calendar source");

export const readPersonalCalendar = async (credentials: CapabilityCaller, signal: AbortSignal) => {
  const sources = await listCalendarSources(credentials, { deadline: Date.now() + 2500, signal });
  const calendars = sources
    .flatMap((source) =>
      source.calendars.filter((calendar) => calendar.suggested).map((calendar) => ({ appId: source.appId, calendarId: calendar.id })),
    )
    .slice(0, 100);
  return readCalendarEvents({
    credentials,
    calendars,
    from: "2026-11-01T00:00:00Z",
    to: "2026-12-01T00:00:00Z",
    signal,
    deadline: Date.now() + 2500,
  });
};
