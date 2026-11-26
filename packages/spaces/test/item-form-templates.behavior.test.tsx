import { afterEach, describe, expect, mock, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ItemFormData } from "../src/frontend/[id]/_components/shared/ItemForm";
import { templateDraftSource } from "../src/frontend/[id]/_components/shared/item-form/templates";
import { addCalendarDays, formatTemplateDate, localNow, proposeTemplateDates, templateSchedule } from "../src/presentation/item-templates";
import { fieldControl, installV2Globals, sendDialog } from "./v2-dom";

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
const offsite: SpaceItemTemplate = {
  ...review,
  id: "Tpl004",
  name: "Offsite",
  title: "Offsite {{date}}",
  location: null,
  durationMinutes: null,
  timeOfDay: null,
  allDay: true,
};

/** The weekday a placeholder shows for a local date. */
const weekdayOf = (date: string) =>
  new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

afterEach(() => mock.restore());

describe("Spaces templates in the new item dialog", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const open = async (
    options: {
      type?: "task" | "event";
      templates?: SpaceItemTemplate[];
      defaults?: { startsAt: string; endsAt: string };
      timeZone?: string;
    } = {},
  ) => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
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
          dateConfig: { timeZone: options.timeZone ?? TIME_ZONE, locale: "en" },
          onSubmit: (data) => {
            submitted.push(data);
          },
          onCancel: () => undefined,
        }),
      dom.root,
    );
    const radio = (group: string, label: string) => {
      // A v2 Choice: a radio group named by its field's label or its own, each option an input inside its label.
      const group_ = [...dom.document.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(
        (element) =>
          element.getAttribute("aria-label") === group ||
          (element.getAttribute("aria-labelledby") &&
            dom.document.getElementById(element.getAttribute("aria-labelledby")!)?.textContent?.trim().startsWith(group)),
      );
      return [...(group_?.querySelectorAll<HTMLLabelElement>("label") ?? [])]
        .find((option) => option.textContent?.trim() === label)
        ?.querySelector<HTMLInputElement>("input");
    };
    const input = (selector: string) => dom.document.querySelector<HTMLInputElement & HTMLTextAreaElement>(selector)!;
    const type = (selector: string, value: string) => {
      input(selector).value = value;
      input(selector).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    const submit = () => sendDialog(dom);
    const close = async () => {
      dispose();
      // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
      await Bun.sleep(20);
      dom.cleanup();
    };
    const button = (label: string, scope: ParentNode = dom.document) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label)!;
    const allDaySwitch = () => dom.document.querySelector<HTMLInputElement>('input[role="switch"]')!;
    const title = () => input('input[placeholder="What needs to be done?"], input[placeholder="Event title"]').value;
    /** Types a day into the date field with these words. */
    const day = (label: string, value: string) => {
      const control = fieldControl(dom, label)!;
      control.value = value;
      control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    /** Answers the open question with the button of these words, once its dialog is there. */
    const answer = async (label: string) => {
      await Bun.sleep(10);
      const question = [...dom.document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].at(-1);
      [...(question?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((element) => element.textContent?.trim() === label)!
        .click();
      await Bun.sleep(10);
    };
    return { dom, radio, input, type, submit, submitted, close, button, allDaySwitch, title, day, answer };
  };

  test("a Space without templates of the kind keeps today's dialog", async () => {
    const view = await open({ templates: [review] });
    expect(view.dom.document.body.textContent).not.toContain("Template");
    await view.close();
  });

  test("choosing a template fills the form, proposes dates, and submits the first one", async () => {
    const view = await open();
    expect(view.radio("Template", "Blank")?.checked).toBe(true);
    expect(view.radio("Template", "Review")).toBeUndefined();

    view.radio("Template", "Weekly report")!.click();
    await Promise.resolve();

    const proposals = proposeTemplateDates(weekly, { now: new Date(), timeZone: TIME_ZONE });
    const [first, second] = proposals;
    expect(view.radio("Due", formatTemplateDate(first!, "en"))?.checked).toBe(true);
    expect(view.radio("Due", "Other date…")).toBeDefined();
    expect(view.radio("Due", "No date")).toBeDefined();
    expect(view.dom.document.body.textContent).toContain("Proposed by the template · Wed or Thu · 16:00");
    expect(view.input('input[placeholder="What needs to be done?"]').value).toStartWith("Weekly report ");
    expect(view.dom.document.body.textContent).toContain("From the template: 2 checklist items · Report · Medium · You");

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
    await view.close();
  });

  test("no date and another date stay one tap away", async () => {
    const view = await open();
    view.radio("Template", "Weekly report")!.click();
    await Promise.resolve();
    view.radio("Due", "Other date…")!.click();
    expect(view.dom.document.body.textContent).toContain("Deadline");
    view.radio("Due", "No date")!.click();
    view.submit();
    await Promise.resolve();
    expect(view.submitted[0]?.deadline).toBeUndefined();
    expect(view.submitted[0]?.checklist).toEqual(["Collect numbers", "Send"]);
    await view.close();
  });

  test("replacing typed input asks first and keeps it when declined", async () => {
    const view = await open();
    view.type('input[placeholder="What needs to be done?"]', "My own task");
    view.radio("Template", "Notes")!.click();
    await Bun.sleep(10);
    expect(view.dom.document.body.textContent).toContain("Use this template?");
    await view.answer("Cancel");
    expect(view.input('input[placeholder="What needs to be done?"]').value).toBe("My own task");
    // Blank stays chosen, for the eye and for the browser, so Notes can be pressed again.
    const marked = (label: string) => view.radio("Template", label)?.checked;
    expect(marked("Blank")).toBe(true);
    expect(marked("Notes")).toBe(false);

    view.radio("Template", "Notes")!.click();
    await view.answer("Replace");
    expect(view.input('input[placeholder="What needs to be done?"]').value).toBe("Notes");
    // A template without a date rule proposes nothing and shows no date row.
    expect(view.dom.document.body.textContent).not.toContain("Proposed by the template");

    // Switching between templates without own input asks nothing.
    view.radio("Template", "Weekly report")!.click();
    await Bun.sleep(10);
    expect(view.dom.document.body.textContent).not.toContain("Use this template?");
    expect(view.radio("Template", "Weekly report")?.checked).toBe(true);
    await view.close();
  });

  test("an event template proposes its start, keeps the range picker, and sets the duration", async () => {
    const view = await open({ type: "event" });
    expect(view.radio("Template", "Weekly report")).toBeUndefined();
    view.radio("Template", "Review")!.click();
    await Promise.resolve();
    const [date] = proposeTemplateDates(review, { now: new Date(), timeZone: TIME_ZONE });
    expect(view.radio("When", formatTemplateDate(date!, "en"))?.checked).toBe(true);
    expect(view.radio("When", "No date")).toBeUndefined();
    expect(view.dom.document.body.textContent).toContain("Start");
    expect(view.dom.document.body.textContent).toContain("Room 2 · 45 min");
    view.submit();
    await Promise.resolve();
    const schedule = templateSchedule(templateDraftSource(review), date!, TIME_ZONE);
    expect(view.submitted[0]).toMatchObject({ title: "Review", startsAt: schedule.startsAt, endsAt: schedule.endsAt, location: "Room 2" });
    expect(view.submitted[0]?.checklist).toBeUndefined();
    await view.close();
  });

  for (const timeZone of ["UTC", "America/New_York", "Europe/Berlin"]) {
    test(`an all-day event template keeps its day in ${timeZone}`, async () => {
      const view = await open({ type: "event", templates: [offsite], timeZone });
      view.radio("Template", "Offsite")!.click();
      await Promise.resolve();
      const [date] = proposeTemplateDates(offsite, { now: new Date(), timeZone });
      view.submit();
      await Promise.resolve();
      const schedule = templateSchedule(templateDraftSource(offsite), date!, timeZone);
      expect(view.dom.document.querySelector('[role="alert"]')).toBeNull();
      expect(view.submitted[0]).toMatchObject({ startsAt: schedule.startsAt, endsAt: schedule.endsAt, allDay: true });
      await view.close();
    });
  }

  test("turning all-day off and on again keeps the template's day", async () => {
    const timeZone = "America/New_York";
    const local = (date: string, time: string) => dates.zonedDateTimeToInstant(`${date}T${time}`, timeZone);
    const view = await open({ type: "event", templates: [offsite], timeZone });
    view.radio("Template", "Offsite")!.click();
    await Promise.resolve();
    const [date] = proposeTemplateDates(offsite, { now: new Date(), timeZone });
    view.allDaySwitch().click();
    view.submit();
    await Promise.resolve();
    expect(view.submitted[0]).toMatchObject({ startsAt: local(date!, "09:00"), endsAt: local(date!, "10:00"), allDay: false });

    view.allDaySwitch().click();
    view.submit();
    await Promise.resolve();
    expect(view.submitted[1]).toMatchObject({
      startsAt: local(date!, "00:00"),
      endsAt: local(addCalendarDays(date!, 1), "00:00"),
      allDay: true,
    });
    await view.close();
  });

  test("an all-day range keeps its days west of UTC", async () => {
    const timeZone = "America/New_York";
    const view = await open({ type: "event", templates: [], timeZone });
    view.type('input[placeholder="Event title"]', "Offsite");
    view.allDaySwitch().click();
    // Until the v2 picker is out (#4159), an all-day range is typed day by day; both days are inclusive.
    const tomorrow = addCalendarDays(localNow(new Date(), timeZone).date, 1);
    view.day("Start", tomorrow);
    view.day("End", tomorrow);
    view.submit();
    await Promise.resolve();
    expect(view.submitted[0]).toMatchObject({
      startsAt: dates.zonedDateTimeToInstant(`${tomorrow}T00:00`, timeZone),
      endsAt: dates.zonedDateTimeToInstant(`${addCalendarDays(tomorrow, 1)}T00:00`, timeZone),
      allDay: true,
    });
    await view.close();
  });

  test("untouched placeholders follow No date, the deadline, and the event start", async () => {
    const today = localNow(new Date(), TIME_ZONE).date;
    const task = await open();
    task.radio("Template", "Weekly report")!.click();
    await Promise.resolve();
    task.radio("Due", "No date")!.click();
    expect(task.title()).toBe(`Weekly report ${weekdayOf(today)}`);
    task.radio("Due", "Other date…")!.click();
    task.day("Deadline", addCalendarDays(today, 1));
    expect(task.title()).toBe(`Weekly report ${weekdayOf(addCalendarDays(today, 1))}`);
    // Own text stays.
    task.type('input[placeholder="What needs to be done?"]', "My report");
    task.day("Deadline", today);
    expect(task.title()).toBe("My report");
    await task.close();

    const event = await open({ type: "event", templates: [{ ...review, title: "Review {{weekday}}" }] });
    event.radio("Template", "Review")!.click();
    await Promise.resolve();
    event.day("Start", addCalendarDays(today, 1));
    expect(event.title()).toBe(`Review ${weekdayOf(addCalendarDays(today, 1))}`);
    await event.close();
  });

  test("an event from a calendar slot keeps the slot until a proposal is chosen", async () => {
    const view = await open({ type: "event", defaults: { startsAt: "2026-11-02T13:00:00.000Z", endsAt: "2026-11-02T14:00:00.000Z" } });
    view.radio("Template", "Review")!.click();
    await Promise.resolve();
    const [date] = proposeTemplateDates(review, { now: new Date(), timeZone: TIME_ZONE });
    expect(view.radio("When", formatTemplateDate(date!, "en"))?.checked).toBe(false);
    view.submit();
    await Promise.resolve();
    expect(view.submitted[0]).toMatchObject({ title: "Review", startsAt: "2026-11-02T13:00:00.000Z", endsAt: "2026-11-02T14:00:00.000Z" });
    await view.close();
  });
});
