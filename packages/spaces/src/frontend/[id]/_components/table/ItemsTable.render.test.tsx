import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceItem } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-items-table-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
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

test("colors each status tag with its column color and falls back to green only for a done column without one", () => {
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
        });
      },
    }),
  );

  const statusTag = (name: string) => html.match(new RegExp(`<span\\b[^>]*>\\s*<span\\b[^>]*>${name}</span>`))?.[0];

  expect(statusTag("Verworfen")).toContain("--k2b-choice-color:#ef4444;");
  expect(statusTag("Verworfen")).not.toContain("--k2b-choice-color:#10b981");
  expect(statusTag("Erledigt")).toContain("--k2b-choice-color:#10b981;");
  expect(statusTag("In progress")).toContain("--k2b-choice-color:#3b82f6;");
  // A completed item in an open column without a color stays untinted, as in List and Kanban.
  expect(statusTag("Backlog")).toBeDefined();
  expect(statusTag("Backlog")).not.toContain("--k2b-choice-color");
});

const renderTable = (item: SpaceItem) =>
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
        });
      },
    }),
  );

test("shows the working assignee once, first, with one green ring", () => {
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
  expect(html.match(/data-ring="success"/g)).toHaveLength(1);
  expect(html.match(/aria-label="Mira Beck is on it"/g)).toHaveLength(1);
  expect(html).not.toContain('aria-label="Mira Beck avatar"');
  expect(html.indexOf('aria-label="Mira Beck is on it"')).toBeLessThan(html.indexOf('aria-label="Valentin Kolb avatar"'));
  expect(html).toContain('title="Mira Beck, Valentin Kolb"');
  expect(html).toContain(">Mira Beck, Valentin Kolb</span>");
});
