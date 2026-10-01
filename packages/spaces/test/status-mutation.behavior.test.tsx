import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const columns: SpaceColumn[] = [
  { id: "22222222-2222-4222-8222-222222222222", spaceId: SPACE_ID, name: "Open", color: "#2563eb", rank: "1024", isDone: false },
  { id: "33333333-3333-4333-8333-333333333333", spaceId: SPACE_ID, name: "Done", color: "#16a34a", rank: "2048", isDone: true },
];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const requests: Array<{ columnIds: string[]; response: ReturnType<typeof deferred<Response>> }> = [];
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        columns: {
          order: {
            $put: ({ json }: { json: { columnIds: string[] } }) => {
              const response = deferred<Response>();
              requests.push({ columnIds: [...json.columnIds], response });
              return response.promise;
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
};

describe("Spaces status mutations", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("captures one same-tick reorder intent and releases its optimistic projection after canonical reconciliation", async () => {
    requests.length = 0;
    const dom = createDomTestHarness();
    const reconciliation = deferred<void>();
    const { StatusesSection } = await import("../src/frontend/[id]/_components/edit/StatusesSection");
    const dispose = render(
      () =>
        createComponent(StatusesSection, {
          spaceId: SPACE_ID,
          columns,
          virtualColumns: [],
          onDirtyChange: () => undefined,
          onSettingsChange: () => reconciliation.promise,
        }),
      dom.root,
    );

    const moveDown = dom.root.querySelector<HTMLButtonElement>('[aria-label="Move Open down"]')!;
    moveDown.click();
    moveDown.click();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.columnIds).toEqual([columns[1]!.id, columns[0]!.id]);
    expect(dom.root.textContent!.indexOf("Done")).toBeLessThan(dom.root.textContent!.indexOf("Open"));

    requests[0]!.response.resolve(new Response(null, { status: 200 }));
    await flush();
    expect(dom.root.textContent!.indexOf("Done")).toBeLessThan(dom.root.textContent!.indexOf("Open"));
    reconciliation.resolve();
    await flush();
    expect(dom.root.textContent!.indexOf("Open")).toBeLessThan(dom.root.textContent!.indexOf("Done"));

    dispose();
    dom.cleanup();
  });

  test("orders an enabled automatic column with the statuses and names it by kind", async () => {
    requests.length = 0;
    const dom = createDomTestHarness();
    const { StatusesSection } = await import("../src/frontend/[id]/_components/edit/StatusesSection");
    const dispose = render(
      () =>
        createComponent(StatusesSection, {
          spaceId: SPACE_ID,
          columns,
          virtualColumns: [{ kind: "overdue", rank: "1536" }],
          onDirtyChange: () => undefined,
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Move Overdue up"]')!.click();
    expect(requests.map((request) => request.columnIds)).toEqual([["overdue", columns[0]!.id, columns[1]!.id]]);
    expect(dom.root.textContent!.indexOf("Overdue")).toBeLessThan(dom.root.textContent!.indexOf("Open"));

    dispose();
    dom.cleanup();
  });
});
