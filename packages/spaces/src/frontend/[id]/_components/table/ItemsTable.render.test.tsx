import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "spaces-items-table-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ItemsTable } = await import("./ItemsTable");
const { LocaleProvider } = await import("@k2b/ui");

const task = (overrides: Partial<SpaceItem> = {}): SpaceItem => ({
  id: "Item01",
  spaceId: "Space1",
  columnId: "Col001",
  title: "Confirm room booking",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  deadlineAllDay: false,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: null,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
  assignees: [],
  tags: [],
  ...overrides,
});

test("states are quiet words; the kind is the title's sign in the Space's colour", () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ItemsTable, {
          items: [
            task({ id: "Item01", columnId: "Open01", title: "Book a room" }),
            task({ id: "Item02", columnId: "Done01", title: "Confirm the booking", completedAt: "2026-08-21T10:00:00.000Z" }),
            task({ id: "Item03", columnId: "Done02", title: "Cancel the alternative booking", completedAt: "2026-08-21T10:00:00.000Z" }),
            task({ id: "Item04", columnId: "Open02", title: "Send the agenda", completedAt: "2026-08-21T10:00:00.000Z" }),
          ],
          currentUserId: "33333333-3333-4333-8333-333333333333",
          spaceId: "Space1",
          columns: [
            { id: "Open01", spaceId: "Space1", name: "In progress", color: "#3b82f6", rank: "1024", isDone: false },
            { id: "Done01", spaceId: "Space1", name: "Erledigt", color: null, rank: "2048", isDone: true },
            { id: "Done02", spaceId: "Space1", name: "Verworfen", color: "#ef4444", rank: "3072", isDone: true },
            { id: "Open02", spaceId: "Space1", name: "Backlog", color: null, rank: "4096", isDone: false },
          ],
          tags: [],
          baseUrl: "/app/spaces/Space1",
          dateConfig: { timeZone: "Europe/Berlin" },
          color: "#6366f1",
        });
      },
    }),
  );

  // Identity B: a good or normal state is neutral, a word without colour; colour stands only for a problem.
  for (const name of ["In progress", "Erledigt", "Verworfen", "Backlog"]) expect(html).toContain(name);
  expect(html).not.toContain("--k2-c:#3b82f6");
  expect(html).not.toContain("--k2-c:#10b981");
  expect(html).not.toContain("--k2-c:#ef4444");
  // The kind leads the title as its sign in the colour of the Space it belongs to; there is no Kind column.
  expect(html.match(/data-k2-part="Mark"/g)?.length).toBeGreaterThanOrEqual(4);
  expect(html).toContain("#6366f1");
  expect(html).not.toContain(">Kind<");
});

const renderTable = (item: SpaceItem, dateConfig?: { timeZone: string }) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ItemsTable, {
          items: [item],
          spaceId: "Space1",
          columns: [],
          tags: [],
          currentUserId: "33333333-3333-4333-8333-333333333333",
          baseUrl: "/app/spaces/Space1",
          dateConfig,
        });
      },
    }),
  );

// The Schedule column is 200 px: an event names its day once and its times as a range, as the list row does.
beforeEach(() => setSystemTime(new Date("2026-10-01T10:00:00Z")));
afterEach(() => setSystemTime());

test("an event's schedule names its day once: one day with its times, several days with both ends", () => {
  const berlin = { timeZone: "Europe/Berlin" };
  const sameDay = renderTable(task({ startsAt: "2026-10-15T12:00:00.000Z", endsAt: "2026-10-15T13:00:00.000Z" }), berlin);
  expect(sameDay).toContain("Thu, Oct 15, 14:00–15:00");
  expect(sameDay).not.toContain("Oct 15, 2026");
  const overnight = renderTable(task({ startsAt: "2026-10-15T20:00:00.000Z", endsAt: "2026-10-16T07:00:00.000Z" }), berlin);
  expect(overnight).toContain("Thu, Oct 15, 22:00 – Fri, Oct 16, 09:00");
  // An all-day event ends at midnight, exclusive: one day stays one day, three days name their last.
  const oneDay = renderTable(task({ startsAt: "2026-10-15T22:00:00.000Z", endsAt: "2026-10-16T22:00:00.000Z", allDay: true }), berlin);
  expect(oneDay).toContain("Fri, Oct 16<");
  const threeDays = renderTable(task({ startsAt: "2026-10-15T22:00:00.000Z", endsAt: "2026-10-18T22:00:00.000Z", allDay: true }), berlin);
  expect(threeDays).toContain("Fri, Oct 16 – Sun, Oct 18");
});

test("names whoever works on the task once, first, as on it", () => {
  const mira = { id: "44444444-4444-4444-8444-444444444444", kind: "user" as const, displayName: "Mira Beck", avatarHash: null };
  const html = renderTable(
    task({
      assignees: [
        { id: "33333333-3333-4333-8333-333333333333", kind: "user" as const, displayName: "Valentin Kolb", avatarHash: null },
        mira,
      ],
      claim: {
        id: "55555555-5555-4555-8555-555555555555",
        actor: { kind: "user", id: mira.id },
        displayName: mira.displayName,
        avatarHash: null,
        claimedAt: "2026-10-02T07:12:00.000Z",
      },
    }),
  );
  // The people are the row's picture: a stack named once with everyone, whoever works on it first, and each face
  // once in that order.
  expect(html).toContain('data-k2-part="Avatar.Stack"');
  expect(html).toContain('aria-label="Mira Beck is on it, Valentin Kolb"');
  const faces = [...html.matchAll(/data-k2-part="Avatar"[^>]*>([A-Z]{2})</g)].map((match) => match[1]);
  expect(faces.slice(0, 2)).toEqual(["MB", "VK"]);
});

test("the table names when an item was created and last updated, as main's table did", async () => {
  const { dates } = await import("@k2b/stdlib");
  const berlin = { timeZone: "Europe/Berlin" };
  const created = "2026-08-20T10:00:00.000Z";
  const updated = "2026-09-02T15:30:00.000Z";
  const html = renderTable(task({ createdAt: created, updatedAt: updated }), berlin);
  expect(html).toContain(">Created<");
  expect(html).toContain(">Updated<");
  expect(html).toContain(dates.formatDateTime(created, berlin));
  expect(html).toContain(dates.formatDateTime(updated, berlin));
});
