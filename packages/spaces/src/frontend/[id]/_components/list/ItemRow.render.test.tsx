import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "spaces-item-row-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ItemRow } = await import("./ItemRow");
const { createLeavingItems } = await import("../shared/leaving");
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

const renderRow = (item: SpaceItem, canWrite = true, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ItemRow, {
          item,
          spaceId: item.spaceId,
          columns: [{ id: "Col001", spaceId: item.spaceId, name: "To Do", color: null, rank: "1024", isDone: false }],
          tags: [],
          isSelected: false,
          baseUrl: "/app/spaces/Space1",
          dateConfig: { timeZone: "Europe/Berlin", locale },
          canWrite,
          currentUserId: "33333333-3333-4333-8333-333333333333",
          isListed: () => true,
          leaving: createLeavingItems<SpaceItem>(),
          list: () => undefined,
          retryToast: () => {},
        });
      },
    }),
  );

test("disables list completion while a task has active blockers, and says why beside it", () => {
  const html = renderRow(task({ activeBlockerCount: 1 }));

  expect(html).toMatch(/<button(?=[^>]*disabled)(?=[^>]*aria-label="Mark complete: Confirm room booking")[^>]*>/);
  expect(html).toContain("Blocked by 1");
});

test.each([1, 3])("renders the German blocked-by label with %s blockers", (count) => {
  const html = renderRow(task({ activeBlockerCount: count }), true, "de");

  expect(html).toContain(`Blockiert durch ${count}`);
  expect(html).not.toContain("Blocked by");
});

test("names a read-only task's toggle by the task alone, so an open task is not announced as completed", () => {
  const html = renderRow(task(), false);

  expect(html).toMatch(/<button(?=[^>]*disabled)(?=[^>]*aria-label="Confirm room booking")[^>]*>/);
  expect(html).not.toContain("Completed:");
});

test.each([
  ["earlier today at 09:00", "2026-10-09T07:00:00Z", false],
  ["today in Berlin but yesterday in UTC", "2026-10-08T22:30:00Z", false],
  ["yesterday", "2026-10-08T07:00:00Z", true],
])("only calls a past-day deadline overdue: %s", (_label, deadline, overdue) => {
  setSystemTime(new Date("2026-10-09T12:00:00Z"));
  try {
    const html = renderRow(task({ deadline }));
    expect(html.includes("Overdue")).toBe(overdue);
  } finally {
    setSystemTime();
  }
});

test("shows whoever works on the task once, first, as on it, with their picture", () => {
  const mira = { id: "44444444-4444-4444-8444-444444444444", kind: "user" as const, displayName: "Mira Beck", avatarHash: null };
  const html = renderRow(
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
  expect(html).toContain('data-k2-part="Avatar" data-k2-avatar role="img" aria-label="Mira Beck"');
  expect(html).toContain("Mira Beck is on it, Valentin Kolb");
  expect(html.match(/Mira Beck/g)).toHaveLength(2);
});

test("shows a claim holder even when the task has no assignees", () => {
  const html = renderRow(
    task({
      assignees: [],
      claim: {
        id: "55555555-5555-4555-8555-555555555555",
        actor: { kind: "service_account", id: "44444444-4444-4444-8444-444444444444" },
        displayName: "Task worker",
        avatarHash: null,
        claimedAt: "2026-10-02T07:12:00.000Z",
      },
    }),
  );
  expect(html).toContain('aria-label="Task worker"');
  expect(html).toContain("Task worker is on it");
});

test("SSR renders a German all-day deadline as the same calendar day", () => {
  setSystemTime(new Date("2025-10-24T12:00:00Z"));
  try {
    const item = task({ deadline: "2025-10-24", deadlineAllDay: true });
    const html = renderRow(item, true, "de");
    expect(html).toContain("Fr., 24. Okt.");
    expect(html).not.toContain("17:00");
    expect(renderRow(item, true, "de")).toBe(html);
  } finally {
    setSystemTime();
  }
});
