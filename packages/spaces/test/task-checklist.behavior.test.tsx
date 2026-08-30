import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
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

    dom.root.querySelector<HTMLInputElement>('[aria-label="Complete Review copy"]')!.click();
    await flush();
    expect(entries[0]?.completed).toBe(true);

    const label = dom.root.querySelector<HTMLInputElement>('[aria-label="Subtask label"]')!;
    label.value = "Review final copy";
    label.dispatchEvent(new Event("input", { bubbles: true }));
    label.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();
    expect(entries[0]?.label).toBe("Review final copy");

    const add = dom.root.querySelector<HTMLInputElement>('[aria-label="Add subtask…"]')!;
    add.value = "Publish";
    add.dispatchEvent(new Event("input", { bubbles: true }));
    add.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(entries.map((entry) => entry.label)).toEqual(["Review final copy", "Publish"]);

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Delete Review final copy"]')!.click();
    await flush();
    expect(entries.map((entry) => entry.label)).toEqual(["Publish"]);

    dispose();
    dom.cleanup();
  });
});
