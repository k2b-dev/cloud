import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceItem } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-item-row-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ItemRow } = await import("./ItemRow");
const { createLeavingItems } = await import("../shared/leaving");

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

const renderRow = (item: SpaceItem, canWrite = true) =>
  renderToString(() =>
    createComponent(ItemRow, {
      item,
      spaceId: item.spaceId,
      columns: [{ id: "Col001", spaceId: item.spaceId, name: "To Do", color: null, rank: "1024", isDone: false }],
      tags: [],
      isSelected: false,
      baseUrl: "/app/spaces/Space1",
      canWrite,
      currentUserId: "33333333-3333-4333-8333-333333333333",
      isListed: () => true,
      leaving: createLeavingItems<SpaceItem>(),
      list: () => undefined,
      retryToast: () => {},
    }),
  );

test("disables overview completion while a task has active blockers", () => {
  const html = renderRow(task({ activeBlockerCount: 1 }));

  expect(html).toContain('title="Complete all blocking tasks first"');
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled[^>]*aria-label="Mark complete: Confirm room booking"/);
  expect(html).toContain("Blocked by 1");
});

test("names a read-only task's checkbox by the task alone, so an open task is not announced as completed", () => {
  const html = renderRow(task(), false);

  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled[^>]*aria-label="Confirm room booking"/);
  expect(html).not.toContain("Completed:");
});
