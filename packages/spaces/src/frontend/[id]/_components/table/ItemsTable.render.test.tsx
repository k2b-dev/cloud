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
          ],
          spaceId: "Space1",
          columns: [
            { id: "Open01", spaceId: "Space1", name: "In progress", color: "#3b82f6", rank: "1024", isDone: false },
            { id: "Done01", spaceId: "Space1", name: "Erledigt", color: null, rank: "2048", isDone: true },
            { id: "Done02", spaceId: "Space1", name: "Verworfen", color: "#ef4444", rank: "3072", isDone: true },
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
});
