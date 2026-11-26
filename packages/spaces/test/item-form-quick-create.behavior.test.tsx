import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ItemFormData } from "../src/frontend/[id]/_components/shared/ItemForm";
import { choose, installV2Globals, sendDialog } from "./v2-dom";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const columns: SpaceColumn[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    spaceId: SPACE_ID,
    name: "Open",
    color: "#2563eb",
    rank: "1024",
    isDone: false,
  },
];

describe("Spaces item quick create", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps entered values when expanding to the full editor", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [],
          quickCreate: true,
          defaults: {
            type: "event",
            columnId: columns[0]!.id,
            startsAt: "2026-08-14T09:00:00.000Z",
            endsAt: "2026-08-14T10:00:00.000Z",
          },
          onSubmit: () => undefined,
          onCancel: () => undefined,
        }),
      dom.root,
    );

    const quickTitle = dom.document.querySelector<HTMLInputElement>('input[placeholder="Event title"]')!;
    quickTitle.value = "Design review";
    quickTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const moreOptions = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "More options",
    )!;
    moreOptions.click();

    expect(dom.document.body.textContent).toContain("Status");
    expect(dom.document.body.textContent).toContain("Location");
    expect(dom.document.body.textContent).toContain("Assignees");
    expect(dom.document.body.textContent).not.toContain("Tasks have a deadline");
    expect(dom.document.querySelector<HTMLInputElement>('input[placeholder="Event title"]')?.value).toBe("Design review");
    expect(dom.document.body.textContent).not.toContain("More options");

    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });

  test("keeps task title and description when expanding to the full editor", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [],
          quickCreate: true,
          defaults: {
            type: "task",
            columnId: columns[0]!.id,
          },
          onSubmit: () => undefined,
          onCancel: () => undefined,
        }),
      dom.root,
    );

    const quickTitle = dom.document.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')!;
    quickTitle.value = "Prepare launch";
    quickTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const quickDescription = dom.document.querySelector<HTMLTextAreaElement>("textarea")!;
    quickDescription.value = "Confirm the release checklist.";
    quickDescription.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const moreOptions = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "More options",
    )!;
    moreOptions.click();

    expect(dom.document.body.textContent).toContain("Status");
    expect(dom.document.body.textContent).toContain("Assignees");
    expect(dom.document.body.textContent).not.toContain("Location");
    expect(dom.document.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')?.value).toBe("Prepare launch");
    expect(dom.document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Confirm the release checklist.");
    expect(dom.document.body.textContent).not.toContain("More options");

    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });

  test("switches item type without losing shared or type-specific values", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [],
          quickCreate: true,
          defaults: {
            type: "event",
            startsAt: "2026-08-14T09:00:00.000Z",
            endsAt: "2026-08-14T10:00:00.000Z",
          },
          onSubmit: () => undefined,
          onCancel: () => undefined,
        }),
      dom.root,
    );

    const title = dom.document.querySelector<HTMLInputElement>('input[placeholder="Event title"]')!;
    title.value = "Design review";
    title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const description = dom.document.querySelector<HTMLTextAreaElement>("textarea")!;
    description.value = "Review the launch screens.";
    description.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    choose(dom, "Task");

    expect(dom.document.body.textContent).toContain("New task");
    expect(dom.document.body.textContent).toContain("Create Task");
    expect(dom.document.body.textContent).not.toContain("Schedule");
    expect(dom.document.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')?.value).toBe("Design review");
    expect(dom.document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Review the launch screens.");

    choose(dom, "Event");

    expect(dom.document.body.textContent).toContain("New event");
    expect(dom.document.body.textContent).toContain("Start");
    expect(dom.document.querySelector<HTMLInputElement>('input[placeholder="Event title"]')?.value).toBe("Design review");

    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });

  test("retains the create key for unchanged retries and replaces it for new intent", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const attempts: ItemFormData[] = [];
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          quickCreate: true,
          defaults: { type: "task" },
          onSubmit: async (data) => {
            attempts.push(data);
            throw new Error("Response lost");
          },
          onCancel: () => undefined,
        }),
      dom.root,
    );
    try {
      const title = dom.document.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')!;
      const type = (value: string) => {
        title.value = value;
        title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      };
      const submit = async () => {
        sendDialog(dom);
        await Promise.resolve();
        await Promise.resolve();
      };
      type("Prepare launch");
      await submit();
      await submit();
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.requestKey).toBeString();
      expect(attempts[1]?.requestKey).toBe(attempts[0]?.requestKey);
      expect(dom.document.body.textContent).toContain("Response lost");
      type("Prepare another launch");
      await submit();
      expect(attempts[2]?.requestKey).not.toBe(attempts[0]?.requestKey);
    } finally {
      dispose();
      // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
      await Bun.sleep(20);
      dom.cleanup();
    }
  });

  test("submits a compact task into the first status", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    let submitted: ItemFormData | undefined;
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [],
          quickCreate: true,
          defaults: { type: "task" },
          onSubmit: (data) => {
            submitted = data;
          },
          onCancel: () => undefined,
        }),
      dom.root,
    );

    const quickTitle = dom.document.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')!;
    quickTitle.value = "Prepare launch";
    quickTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    sendDialog(dom);

    expect(submitted?.title).toBe("Prepare launch");
    expect(submitted?.description).toBeUndefined();
    expect(submitted?.columnId).toBe(columns[0]!.id);

    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });

  test("a template the opener chose keeps the opener's title and tags beside the template's", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const tag = (id: string, name: string) => ({ id, spaceId: SPACE_ID, name, color: "#16a34a" });
    const filterTag = tag("Tag001", "Touren");
    const templateTag = tag("Tag002", "Lager");
    let submitted: ItemFormData | undefined;
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [filterTag, templateTag],
          templates: [
            {
              id: "Tpl001",
              spaceId: SPACE_ID,
              kind: "task",
              name: "Wareneingang",
              icon: null,
              title: "Wareneingang prüfen",
              description: null,
              priority: null,
              tags: [templateTag],
              assignees: [],
              assignCreator: false,
              checklist: ["Lieferschein"],
              estimatedDurationMinutes: null,
              location: null,
              url: null,
              allDay: false,
              durationMinutes: null,
              timeOfDay: null,
              dateRule: { type: "none" },
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          quickCreate: true,
          // As the calendar's quick create hands over to the dialog: a typed title, a due day, and the filter's tag.
          defaults: {
            type: "task",
            title: "Wareneingang Spedition Nord",
            deadline: "2026-11-02",
            tagIds: [filterTag.id],
            templateId: "Tpl001",
          },
          onSubmit: (data) => {
            submitted = data;
          },
          onCancel: () => undefined,
        }),
      dom.root,
    );
    // The template applies once the form mounted; the test's timeout bounds the wait.
    const chosen = () => dom.document.body.textContent?.includes("From the template:") ?? false;
    while (!chosen()) await Bun.sleep(0);
    sendDialog(dom);
    while (!submitted) await Bun.sleep(0);

    expect(submitted).toMatchObject({
      title: "Wareneingang Spedition Nord",
      deadline: "2026-11-02",
      tagIds: [filterTag.id, templateTag.id],
      checklist: ["Lieferschein"],
    });

    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  });
});
