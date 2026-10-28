import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CalendarEventsDataSchema, CalendarListDataSchema, type CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import "../../../../scripts/fixtures/authorization-preload";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import spacesApi from "../api";
import { spacesCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { listSourceCalendars, readSourceEvents } from "./calendar-source";
import * as calendarView from "./calendar-view";

const suite = databaseSuite();
afterEach(() => setSystemTime());
const range = { from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
suite("Spaces Cloud calendar source", () => {
  test("readable calendars, deadlines, all-day items, recurring page boundaries and stable occurrence identity", async () => {
    setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const [reader] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${crypto.randomUUID()}, 'local', 'user', 'Calendar source reader') RETURNING id`;
    const spaceIds: string[] = [];
    const accessIds: string[] = [];
    let accountId: string | undefined;
    try {
      const space = async (name: string) => {
        const [row] = await sql<
          { id: string; short_id: string }[]
        >`INSERT INTO spaces.spaces (short_id, name, color) VALUES (${newShortId()}, ${name}, '#6366f1') RETURNING id, short_id`;
        spaceIds.push(row!.id);
        const [column] = await sql<
          { id: string }[]
        >`INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${row!.id}::uuid, 'Open', 1024) RETURNING id`;
        return { ...row!, columnId: column!.id };
      };
      const own = await space("Calendar source team");
      const foreign = await space("Calendar source private");
      const grant = async (spaceId: string, principal: { userId?: string; accountId?: string }) => {
        const [access] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access (user_id, service_account_id, permission) VALUES (${principal.userId ?? null}::uuid, ${principal.accountId ?? null}::uuid, 'read') RETURNING id`;
        accessIds.push(access!.id);
        await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
      };
      await grant(own.id, { userId: reader!.id });
      const createItem = async (
        target: typeof own,
        title: string,
        fields: {
          start?: string;
          end?: string;
          deadline?: string;
          date?: string;
          allDay?: boolean;
          rule?: string;
          parent?: string;
          original?: string;
          done?: boolean;
        } = {},
      ) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at, deadline, deadline_date, all_day, recurrence_rrule, recurrence_dtstart, recurring_event_id, recurrence_id, completed_at, updated_at)
          VALUES (${newShortId()}, ${target.id}::uuid, ${target.columnId}::uuid, ${title}, ${fields.start ?? null}::timestamptz, ${fields.end ?? null}::timestamptz, ${fields.deadline ?? null}::timestamptz, ${fields.date ?? null}::date,
            ${fields.allDay ?? false}, ${fields.rule ?? null}, ${fields.rule ? fields.start : null}::timestamptz, ${fields.parent ?? null}::uuid, ${fields.original ?? null}::timestamptz, ${fields.done ? "2026-03-01T00:00:00Z" : null}::timestamptz, '2026-03-01T00:00:00Z') RETURNING id, short_id`;
        return row!;
      };
      await createItem(foreign, "Private", { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" });
      const dateDeadline = await createItem(own, "Date deadline", { date: "2026-03-02" });
      await createItem(own, "Event outside with deadline inside", {
        start: "2026-04-05T09:00:00Z",
        end: "2026-04-05T10:00:00Z",
        date: "2026-03-02",
      });
      await createItem(own, "Timed deadline", { deadline: "2026-03-02T15:00:00Z" });
      await createItem(own, "All-day legacy", { start: "2026-03-02T23:00:00Z", end: "2026-03-03T22:59:59.999Z", allDay: true });
      await createItem(own, "All-day exclusive", { start: "2026-03-03T23:00:00Z", end: "2026-03-04T23:00:00Z", allDay: true });
      await createItem(own, "Completed", { date: "2026-03-02", done: true });
      await createItem(own, "Undated");
      await createItem(own, "Exclusive upper bound", { deadline: range.to });
      const series = await createItem(own, "Daily", {
        start: "2026-03-01T09:00:00Z",
        end: "2026-03-01T09:30:00Z",
        rule: "FREQ=DAILY;COUNT=31",
      });
      for (let index = 0; index < 3; index++)
        await createItem(own, `Daily ${index}`, {
          start: "2026-03-01T10:00:00Z",
          end: "2026-03-01T10:30:00Z",
          rule: "FREQ=DAILY;COUNT=31",
        });
      const context = { subject: { type: "user" as const, userId: reader!.id }, dateConfig: { timeZone: "Europe/Berlin", locale: "en" } };
      const listed = CalendarListDataSchema.parse(await listSourceCalendars({}, context));
      expect(listed.items.find((entry) => entry.id === own.short_id)).toMatchObject({
        suggested: true,
        visibility: "details",
        writable: false,
      });
      expect(listed.items.some((entry) => entry.id === foreign.short_id)).toBe(false);
      const input = { ...range, calendarIds: [own.short_id, foreign.short_id, "unknown"], limit: 100 };
      const first = CalendarEventsDataSchema.parse(await readSourceEvents(input, context));
      expect(first.items).toHaveLength(100);
      expect(first.next).not.toBeNull();
      const second = CalendarEventsDataSchema.parse(await readSourceEvents({ ...input, cursor: first.next! }, context));
      const all = [...first.items, ...second.items];
      expect(all).toHaveLength(128);
      expect(second.next).toBeNull();
      // Completing an earlier row must not shift the next chronological page.
      await sql`UPDATE spaces.items SET completed_at = '2026-03-02T00:00:00Z' WHERE id = ${dateDeadline.id}::uuid`;
      const afterCompletion = await readSourceEvents({ ...input, cursor: first.next! }, context);
      expect(afterCompletion.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
      await sql`UPDATE spaces.items SET completed_at = NULL WHERE id = ${dateDeadline.id}::uuid`;
      await sql`UPDATE spaces.spaces SET color = 'legacy' WHERE id = ${own.id}::uuid`;
      const legacyColors = CalendarListDataSchema.parse(await listSourceCalendars({}, context));
      expect(legacyColors.items.find((entry) => entry.id === own.short_id)).not.toHaveProperty("color");
      await sql`UPDATE spaces.spaces SET color = '#6366f1' WHERE id = ${own.id}::uuid`;
      expect(all.every((entry) => entry.calendarId === own.short_id)).toBe(true);
      const west = await readSourceEvents(
        { calendarIds: [own.short_id], from: "2026-03-02T08:00:00Z", to: "2026-03-03T08:00:00Z" },
        { ...context, dateConfig: { ...context.dateConfig, timeZone: "America/Los_Angeles" } },
      );
      expect(west.items.find((entry) => entry.type === "deadline" && entry.title === "Date deadline")).toMatchObject({
        due: { kind: "date", date: "2026-03-02" },
      });
      expect(west.items.findIndex((entry) => entry.type === "event" && entry.title === "All-day legacy")).toBeLessThan(
        west.items.findIndex((entry) => entry.type === "deadline" && entry.title === "Timed deadline"),
      );
      expect(all.find((entry) => entry.type === "deadline" && entry.title === "Date deadline")).toMatchObject({
        type: "deadline",
        due: { kind: "date", date: "2026-03-02" },
        done: false,
      });
      expect(all.find((entry) => entry.type === "deadline" && entry.title === "Timed deadline")).toMatchObject({
        type: "deadline",
        due: { kind: "instant", at: "2026-03-02T15:00:00.000Z", timeZone: "Europe/Berlin" },
      });
      expect(all.find((entry) => entry.type === "event" && entry.title === "All-day legacy")).toMatchObject({
        time: { kind: "date", start: "2026-03-03", end: "2026-03-04" },
      });
      expect(all.find((entry) => entry.type === "event" && entry.title === "All-day exclusive")).toMatchObject({
        time: { kind: "date", start: "2026-03-04", end: "2026-03-05" },
      });
      expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
      const occurrence = all.find((entry) => entry.type === "event" && entry.occurrence?.seriesId === series.short_id)!;
      if (occurrence.type !== "event" || !occurrence.occurrence) throw new Error("Missing recurring event");
      const original = occurrence.occurrence.originalStart;
      const override = await createItem(own, "Moved", {
        parent: series.id,
        original,
        start: "2026-03-20T09:00:00Z",
        end: "2026-03-20T09:30:00Z",
      });
      const movedPage = await readSourceEvents({ ...input, limit: 100 }, context);
      const movedNext = movedPage.next ? await readSourceEvents({ ...input, cursor: movedPage.next }, context) : { items: [] };
      const moved = [...movedPage.items, ...movedNext.items].find((entry) => entry.id === occurrence.id);
      expect(moved).toMatchObject({
        type: "event",
        title: "Moved",
        occurrence: { seriesId: series.short_id, originalStart: original, rule: "FREQ=DAILY;COUNT=31" },
      });
      expect(moved?.id).not.toBe(override.short_id);
      expect(moved?.type === "event" && moved.version).not.toBe(occurrence.version);
      expect(moved?.type === "event" && moved.open?.href).toContain(`item=${series.short_id}&occurrence=`);
      await expect(readSourceEvents({ ...input, to: "2026-04-02T00:00:00Z" }, context)).rejects.toThrow();
      await expect(readSourceEvents({ ...input, to: range.from }, context)).rejects.toThrow();
      await expect(readSourceEvents({ ...input, calendarIds: [own.short_id], cursor: first.next! }, context)).rejects.toThrow(
        "CALENDAR_INVALID_CURSOR",
      );
      expect((await readSourceEvents({ ...input, calendarIds: [foreign.short_id] }, context)).items).toEqual([]);

      const account = await serviceAccounts.createResourceBound({
        name: "Calendar key",
        appId: "spaces",
        resourceType: "space",
        resourceId: own.id,
      });
      if (!account.ok) throw new Error(account.error.message);
      accountId = account.data.id;
      await grant(own.id, { accountId });
      await grant(foreign.id, { accountId });
      const boundToken = await serviceAccountCredentials.createApiToken({
        serviceAccountId: accountId,
        name: "Calendar bound test",
        scopes: ["read"],
      });
      if (!boundToken.ok) throw new Error(boundToken.error.message);
      for (const path of ["/calendar/sources", `/calendar/events?${new URLSearchParams(range)}`]) {
        const response = await spacesApi.request(path, { headers: { authorization: `Bearer ${boundToken.data.token}` } });
        expect(response.status).toBe(403);
      }
      const bound: CapabilityExecutionContext = {
        actor: { kind: "service_account", serviceAccount: account.data, delegatedUser: null, scopes: ["read"] },
        accessSubject: { type: "service_account", serviceAccountId: accountId },
        user: null,
        locale: "en",
        requestId: "calendar-source-test",
        origin: "app",
        signal: new AbortController().signal,
      };
      const listedBound = await spacesCapabilities.queries["calendar.list"].run({}, bound);
      expect(listedBound.ok && listedBound.data.data.items.map((entry) => entry.id)).toEqual([own.short_id]);
      const boundEvents = await spacesCapabilities.queries["calendar.events"].run(input, bound);
      expect(boundEvents.ok).toBe(true);
      if (!boundEvents.ok) throw new Error(boundEvents.error.message);
      expect(boundEvents.data.data.items.every((entry) => entry.calendarId === own.short_id)).toBe(true);
      const refused = await spacesCapabilities.queries["calendar.events"].run(input, {
        ...bound,
        actor: {
          ...bound.actor,
          kind: "service_account",
          serviceAccount: { ...account.data, appId: "other" },
          delegatedUser: null,
          scopes: ["read"],
        },
      });
      expect(refused.ok).toBe(false);
      const loadedUser = await accounts.users.get({ id: reader!.id });
      if (!loadedUser) throw new Error("Missing reader");
      const userContext: CapabilityExecutionContext = {
        actor: { kind: "user", user: loadedUser },
        accessSubject: context.subject,
        user: loadedUser,
        locale: "en",
        requestId: "calendar-source-test",
        origin: "app",
        signal: new AbortController().signal,
      };
      const token = await serviceAccountCredentials.createUserApiToken({
        user: loadedUser,
        browserSignIn: await createTestBrowserSignIn(loadedUser.id),
        name: "Calendar source test",
      });
      if (!token.ok) throw new Error(token.error.message);
      const request = (query: string) =>
        spacesApi.request(`/calendar/events?${query}`, { headers: { authorization: `Bearer ${token.data.token}` } });
      const empty = await request(new URLSearchParams(range).toString());
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ items: [], sources: [] });
      const wide = await request(new URLSearchParams({ ...range, to: "2026-04-13T00:00:00Z" }).toString());
      expect(wide.status).toBe(400);
      expect(await wide.json()).toMatchObject({ code: "CALENDAR_INVALID_RANGE" });
      const malformed = await request(new URLSearchParams({ ...range, cal: "missing-colon" }).toString());
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "CALENDAR_INVALID_SELECTION" });
      // An unreachable catalog is a temporary outage: 503 says "try again later", never an empty or failed calendar.
      const outage = spyOn(calendarView, "loadCalendarSources").mockRejectedValue(new Error("catalog unreachable"));
      try {
        const sources = await spacesApi.request("/calendar/sources", { headers: { authorization: `Bearer ${token.data.token}` } });
        expect(sources.status).toBe(503);
        expect(await sources.json()).toEqual({ code: "CALENDAR_DISCOVERY_FAILED", message: "Calendar discovery is unavailable" });
      } finally {
        outage.mockRestore();
      }
      const manifest = compileCapabilityManifest("spaces", spacesCapabilities);
      expect(manifest.calendarSource).toEqual({ calendars: "calendar.list", events: "calendar.events" });
      const valid = await spacesCapabilities.queries["calendar.events"].run(input, userContext);
      expect(valid.ok && CalendarEventsDataSchema.safeParse(valid.data.data).success).toBe(true);
    } finally {
      for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      if (accountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${reader!.id}::uuid`;
    }
  });
});
