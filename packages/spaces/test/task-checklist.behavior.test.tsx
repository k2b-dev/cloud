import { describe, expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

let entries = [
  {
    id: "Step01",
    label: "Review copy",
    completed: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  },
];

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          [":itemId"]: {
            checklist: {
              $post: async ({ json: body }: { json: { label: string } }) => {
                const entry = {
                  id: "Step02",
                  label: body.label,
                  completed: false,
                  createdAt: "2026-08-30T11:00:00.000Z",
                  updatedAt: "2026-08-30T11:00:00.000Z",
                };
                entries = [...entries, entry];
                return json(entry);
              },
              [":entryId"]: {
                $patch: async ({ param, json: body }: { param: { entryId: string }; json: { label?: string; completed?: boolean } }) => {
                  entries = entries.map((entry) => (entry.id === param.entryId ? { ...entry, ...body } : entry));
                  return json(entries.find((entry) => entry.id === param.entryId));
                },
                $delete: async ({ param }: { param: { entryId: string } }) => {
                  entries = entries.filter((entry) => entry.id !== param.entryId);
                  return json({ deleted: true });
                },
              },
            },
          },
        },
      },
    },
  }));
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("Spaces task checklist", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("adds, checks, renames, and removes label-only subtasks", async () => {
    entries = [
      {
        id: "Step01",
        label: "Review copy",
        completed: false,
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
      },
    ];
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: TaskChecklistSection } = await import("../src/frontend/[id]/_components/detail/TaskChecklistSection");
    const dispose = render(
      () =>
        createComponent(TaskChecklistSection, {
          spaceId: "Space1",
          itemId: "Item01",
          entries,
          canWrite: true,
          onChanged: () => undefined,
        }),
      dom.root,
    );

    Object.assign(globalThis, {
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLSlotElement: dom.window.HTMLSlotElement,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    const check = (label: string) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>('[data-k2-part="Check"]'))
        .find((entry) => entry.textContent?.trim() === label)
        ?.querySelector("input");
    const button = (label: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label,
      );
    const enter = (input: HTMLInputElement | HTMLTextAreaElement) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    check("Complete Review copy")!.click();
    await flush();
    expect(entries[0]?.completed).toBe(true);

    // A subtask is renamed and removed in the panel behind its pencil.
    button("Subtask label")!.click();
    await flush();
    const label =
      dom.document.querySelector<HTMLInputElement>('input[name="checklist-Step01"], [data-k2-part="Field"] input[value="Review copy"]') ??
      Array.from(dom.document.querySelectorAll<HTMLInputElement>("input")).find((input) => input.value === "Review copy")!;
    label.value = "Review final copy";
    label.dispatchEvent(new Event("input", { bubbles: true }));
    enter(label);
    await flush();
    expect(entries[0]?.label).toBe("Review final copy");

    const add = dom.root.querySelector<HTMLInputElement>('input[placeholder="Add subtask…"]')!;
    add.value = "Publish";
    add.dispatchEvent(new Event("input", { bubbles: true }));
    enter(add);
    await flush();
    expect(entries.map((entry) => entry.label)).toEqual(["Review final copy", "Publish"]);

    button("Subtask label")!.click();
    await flush();
    button("Delete Review final copy")!.click();
    await flush();
    expect(entries.map((entry) => entry.label)).toEqual(["Publish"]);

    dispose();
    dom.cleanup();
  });

  test("preserves an unfinished subtask draft while live entries refresh", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: TaskChecklistSection } = await import("../src/frontend/[id]/_components/detail/TaskChecklistSection");
    const [liveEntries, setLiveEntries] = createSignal(entries);
    const dispose = render(
      () =>
        createComponent(TaskChecklistSection, {
          spaceId: "Space1",
          itemId: "Item01",
          get entries() {
            return liveEntries();
          },
          canWrite: true,
          onChanged: () => undefined,
        }),
      dom.root,
    );
    const add = dom.root.querySelector<HTMLInputElement>('input[placeholder="Add subtask…"]')!;
    add.value = "Unfinished draft";
    add.dispatchEvent(new Event("input", { bubbles: true }));
    setLiveEntries([...entries]);
    await flush();
    expect(add.value).toBe("Unfinished draft");

    dispose();
    dom.cleanup();
  });
});
