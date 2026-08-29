import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

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

    const quickTitle = dom.root.querySelector<HTMLInputElement>('input[placeholder="Event title"]')!;
    quickTitle.value = "Design review";
    quickTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const moreOptions = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "More options",
    )!;
    moreOptions.click();

    expect(dom.root.textContent).toContain("General");
    expect(dom.root.textContent).toContain("Event details");
    expect(dom.root.textContent).toContain("Organize");
    expect(dom.root.textContent).not.toContain("Tasks have a deadline");
    expect(dom.root.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')?.value).toBe("Design review");
    expect(dom.root.textContent).not.toContain("More options");

    dispose();
    dom.cleanup();
  });

  test("keeps task title and description when expanding to the full editor", async () => {
    const dom = createDomTestHarness();
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

    const quickTitle = dom.root.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')!;
    quickTitle.value = "Prepare launch";
    quickTitle.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const addDescription = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add description",
    )!;
    addDescription.click();
    const quickDescription = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    quickDescription.value = "Confirm the release checklist.";
    quickDescription.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const moreOptions = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "More options",
    )!;
    moreOptions.click();

    expect(dom.root.textContent).toContain("General");
    expect(dom.root.textContent).toContain("Organize");
    expect(dom.root.textContent).not.toContain("Event details");
    expect(dom.root.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]')?.value).toBe("Prepare launch");
    expect(dom.root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Confirm the release checklist.");
    expect(dom.root.textContent).not.toContain("More options");

    dispose();
    dom.cleanup();
  });
});
