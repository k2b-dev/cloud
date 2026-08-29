import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Recurrence, SpaceColumn } from "@/contracts";
import { itemCreateDialogOptions } from "./item-form/dialog";

const root = mkdtempSync(join(tmpdir(), "spaces-item-form-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ItemForm } = await import("./ItemForm");

const spaceId = "Space1";
const columns: SpaceColumn[] = [
  {
    id: "Col001",
    spaceId,
    name: "Ideas",
    color: "#2563eb",
    rank: "1024",
    isDone: false,
  },
];

const renderForm = (type: "task" | "event", recurrence?: Recurrence, quickCreate = false) =>
  renderToString(() =>
    createComponent(ItemForm, {
      spaceId,
      columns,
      tags: [],
      quickCreate,
      defaults: {
        type,
        columnId: columns[0]!.id,
        ...(type === "event"
          ? {
              startsAt: "2026-08-14T09:00:00.000Z",
              endsAt: "2026-08-14T10:00:00.000Z",
              recurrence,
            }
          : {}),
      },
      onSubmit: () => undefined,
      onCancel: () => undefined,
    }),
  );

describe("Spaces item form", () => {
  test("uses the responsive create-dialog frame", () => {
    expect(itemCreateDialogOptions.panelClassName).toContain("spaces-item-create-dialog");
    expect(typeof itemCreateDialogOptions.initialFocus).toBe("function");
  });

  test("always renders task organization without an options toggle", () => {
    const html = renderForm("task");

    expect(html).toContain(">General</h3>");
    expect(html).toContain("Core details and timing.");
    expect(html).toContain(">Organize</h3>");
    expect(html).toContain(">Status<span");
    expect(html).toContain(">Priority</label>");
    expect(html).toContain("Assignees");
    expect(html).not.toContain("More options");
    expect(html).not.toContain("Hide options");
    expect(html).not.toContain("Edit repeat");
    expect(html).not.toContain(">Repeat</h3>");
    expect(html).not.toContain(">Event details</h3>");
    expect(html).toContain('class="ml-auto flex items-center gap-2"');
  });

  test("always renders event recurrence, details, and organization", () => {
    const html = renderForm("event");

    expect(html).toContain(">General</h3>");
    expect(html).toContain("Core details and timing.");
    expect(html).toContain(">Repeat</h3>");
    expect(html).toContain(">Event details</h3>");
    expect(html).toContain(">Organize</h3>");
    expect(html).not.toContain("More options");
    expect(html).not.toContain("Hide options");
    expect(html).not.toContain("Edit repeat");
  });

  test("renders a focused quick-create form for a new event", () => {
    const html = renderForm("event", undefined, true);

    expect(html).toContain('role="radiogroup" aria-label="Type"');
    expect(html).toContain('data-presentation="compact"');
    expect(html).toContain('placeholder="Event title"');
    expect(html).toContain('placeholder="Description in Markdown..."');
    expect(html).toContain(">Schedule<span");
    expect(html).toContain("All-day event");
    expect(html).toContain("More options");
    expect(html).not.toContain(">Repeat</label>");
    expect(html).not.toContain("Add description");
    expect(html).not.toContain("Add location or link");
    expect(html).not.toContain(">General</h3>");
    expect(html).not.toContain(">Event details</h3>");
    expect(html).not.toContain(">Organize</h3>");
  });

  test("renders a focused quick-create form for a new task", () => {
    const html = renderForm("task", undefined, true);

    expect(html).toContain('role="radiogroup" aria-label="Type"');
    expect(html).toContain('data-presentation="compact"');
    expect(html).toContain('placeholder="What needs to be done?"');
    expect(html).toContain('placeholder="Description in Markdown..."');
    expect(html).toContain("More options");
    expect(html).not.toContain("Add description");
    expect(html).not.toContain(">Schedule<span");
    expect(html).not.toContain("All-day event");
    expect(html).not.toContain("Add location or link");
    expect(html).not.toContain(">General</h3>");
    expect(html).not.toContain(">Organize</h3>");
  });

  test("pairs the recurrence end mode with its date field", () => {
    const html = renderForm("event", {
      rrule: "FREQ=DAILY;UNTIL=20260815T235959Z",
      dtstart: "2026-08-14T09:00:00.000Z",
      exdate: [],
    });

    expect(html).toContain(">Ends</label>");
    expect(html).toContain(">Until</label>");
    expect(html).toContain("15 Aug 2026");
    expect(html).toContain("Repeats every day at 09:00 until Sat 15 Aug 2026");
  });
});
