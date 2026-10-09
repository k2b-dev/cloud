import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ItemFormData } from "../src/frontend/[id]/_components/shared/ItemForm";
import { templateDraftSource } from "../src/frontend/[id]/_components/shared/item-form/templates";
import { formatTemplateDate, proposeTemplateDates, templateSchedule } from "../src/presentation/item-templates";

const SPACE_ID = "Space1";
const TIME_ZONE = "Europe/Berlin";
const columns: SpaceColumn[] = [{ id: "Col001", spaceId: SPACE_ID, name: "Open", color: null, rank: "1024", isDone: false }];
const tag: SpaceTag = { id: "Tag001", spaceId: SPACE_ID, name: "Report", color: "#8b5cf6" };
const base = { spaceId: SPACE_ID, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
const weekly: SpaceItemTemplate = {
  ...base,
  id: "Tpl001",
  kind: "task",
  name: "Weekly report",
  title: "Weekly report {{weekday}}",
  description: "What happened before {{date}}?",
  priority: "medium",
  tags: [tag],
  assignees: [],
  assignCreator: true,
  checklist: ["Collect numbers", "Send"],
  estimatedDurationMinutes: null,
  location: null,
  url: null,
  allDay: false,
  durationMinutes: null,
  timeOfDay: "16:00",
  dateRule: { type: "weekdays", weekdays: ["WE", "TH"] },
};
const notes: SpaceItemTemplate = {
  ...weekly,
  id: "Tpl002",
  name: "Notes",
  title: "Notes",
  description: null,
  priority: null,
  tags: [],
  assignCreator: false,
  checklist: [],
  dateRule: { type: "none" },
};
const review: SpaceItemTemplate = {
  ...weekly,
  id: "Tpl003",
  kind: "event",
  name: "Review",
  title: "Review",
  description: null,
  checklist: [],
  location: "Room 2",
  durationMinutes: 45,
  timeOfDay: "10:00",
  dateRule: { type: "offset", days: 2 },
};

afterEach(() => mock.restore());

describe("Spaces templates in the new item dialog", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const open = async (
    options: { type?: "task" | "event"; templates?: SpaceItemTemplate[]; defaults?: { startsAt: string; endsAt: string } } = {},
  ) => {
    const dom = createDomTestHarness();
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const submitted: ItemFormData[] = [];
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [tag],
          templates: options.templates ?? [weekly, notes, review],
          quickCreate: true,
          defaults: { type: options.type ?? "task", ...options.defaults },
          dateConfig: { timeZone: TIME_ZONE, locale: "en" },
          onSubmit: (data) => {
            submitted.push(data);
          },
          onCancel: () => undefined,
        }),
      dom.root,
    );
    const radio = (group: string, label: string) => {
      const radios = [...dom.root.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"]`)].find(
        (element) =>
          element.getAttribute("aria-labelledby") &&
          dom.root.querySelector(`#${element.getAttribute("aria-labelledby")}`)?.textContent === group,
      );
      return [...(radios?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
        (button) => button.textContent?.trim() === label,
      );
    };
    const input = (selector: string) => dom.root.querySelector<HTMLInputElement & HTMLTextAreaElement>(selector)!;
    const type = (selector: string, value: string) => {
      input(selector).value = value;
      input(selector).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    const submit = () => dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    const close = () => {
      dispose();
      dom.cleanup();
    };
    return { dom, radio, input, type, submit, submitted, close };
  };

  test("a Space without templates of the kind keeps today's dialog", async () => {
    const view = await open({ templates: [review] });
    expect(view.dom.root.textContent).not.toContain("Template");
    view.close();
  });

  test("choosing a template fills the form, proposes dates, and submits the first one", async () => {
    const view = await open();
    expect(view.radio("Template", "Blank")?.getAttribute("aria-checked")).toBe("true");
    expect(view.radio("Template", "Review")).toBeUndefined();

    view.radio("Template", "Weekly report")!.click();
    await Promise.resolve();

    const proposals = proposeTemplateDates(weekly, { now: new Date(), timeZone: TIME_ZONE });
    const [first, second] = proposals;
    expect(view.radio("Due", formatTemplateDate(first!, "en"))?.getAttribute("aria-checked")).toBe("true");
    expect(view.radio("Due", "Other date…")).toBeDefined();
    expect(view.radio("Due", "No date")).toBeDefined();
    expect(view.dom.root.textContent).toContain("Proposed by the template · Wed or Thu · 16:00");
    expect(view.input('input[placeholder="What needs to be done?"]').value).toStartWith("Weekly report ");
    expect(view.dom.root.querySelector('[data-testid="template-summary"]')?.textContent).toBe(
      "From the template: 2 checklist items · Report · Medium · You",
    );

    // Another proposal moves the deadline and the untouched placeholders with it.
    view.radio("Due", formatTemplateDate(second!, "en"))!.click();
    const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(new Date(`${second}T12:00:00Z`));
    expect(view.input('input[placeholder="What needs to be done?"]').value).toBe(`Weekly report ${weekday}`);
    view.submit();
    await Promise.resolve();

    expect(view.submitted[0]).toMatchObject({
      title: `Weekly report ${weekday}`,
      deadline: templateSchedule(templateDraftSource(weekly), second!, TIME_ZONE).deadline,
      priority: "medium",
      tagIds: [tag.id],
      checklist: ["Collect numbers", "Send"],
      assignCreator: true,
      columnId: columns[0]!.id,
    });
    view.close();
  });

  test("no date and another date stay one tap away", async () => {
    const view = await open();
    view.radio("Template", "Weekly report")!.click();
    await Promise.resolve();
    view.radio("Due", "Other date…")!.click();
    expect(view.dom.root.textContent).toContain("Deadline");
    view.radio("Due", "No date")!.click();
    view.submit();
    await Promise.resolve();
    expect(view.submitted[0]?.deadline).toBeUndefined();
    expect(view.submitted[0]?.checklist).toEqual(["Collect numbers", "Send"]);
    view.close();
  });

  test("replacing typed input asks first and keeps it when declined", async () => {
    const view = await open();
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
    view.type('input[placeholder="What needs to be done?"]', "My own task");
    view.radio("Template", "Notes")!.click();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(view.input('input[placeholder="What needs to be done?"]').value).toBe("My own task");
    expect(view.radio("Template", "Blank")?.getAttribute("aria-checked")).toBe("true");

    confirm.mockResolvedValue(true);
    view.radio("Template", "Notes")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.input('input[placeholder="What needs to be done?"]').value).toBe("Notes");
    // A template without a date rule proposes nothing and shows no date row.
    expect(view.dom.root.textContent).not.toContain("Proposed by the template");

    // Switching between templates without own input asks nothing.
    view.radio("Template", "Weekly report")!.click();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(2);
    view.close();
  });

  test("an event template proposes its start, keeps the range picker, and sets the duration", async () => {
    const view = await open({ type: "event" });
    expect(view.radio("Template", "Weekly report")).toBeUndefined();
    view.radio("Template", "Review")!.click();
    await Promise.resolve();
    const [date] = proposeTemplateDates(review, { now: new Date(), timeZone: TIME_ZONE });
    expect(view.radio("When", formatTemplateDate(date!, "en"))?.getAttribute("aria-checked")).toBe("true");
    expect(view.radio("When", "No date")).toBeUndefined();
    expect(view.dom.root.textContent).toContain("Schedule");
    expect(view.dom.root.querySelector('[data-testid="template-summary"]')?.textContent).toContain("Room 2 · 45 min");
    view.submit();
    await Promise.resolve();
    const schedule = templateSchedule(templateDraftSource(review), date!, TIME_ZONE);
    expect(view.submitted[0]).toMatchObject({ title: "Review", startsAt: schedule.startsAt, endsAt: schedule.endsAt, location: "Room 2" });
    expect(view.submitted[0]?.checklist).toBeUndefined();
    view.close();
  });

  test("an event from a calendar slot keeps the slot until a proposal is chosen", async () => {
    const view = await open({ type: "event", defaults: { startsAt: "2026-11-02T13:00:00.000Z", endsAt: "2026-11-02T14:00:00.000Z" } });
    view.radio("Template", "Review")!.click();
    await Promise.resolve();
    const [date] = proposeTemplateDates(review, { now: new Date(), timeZone: TIME_ZONE });
    expect(view.radio("When", formatTemplateDate(date!, "en"))?.getAttribute("aria-checked")).toBe("false");
    view.submit();
    await Promise.resolve();
    expect(view.submitted[0]).toMatchObject({ title: "Review", startsAt: "2026-11-02T13:00:00.000Z", endsAt: "2026-11-02T14:00:00.000Z" });
    view.close();
  });
});
