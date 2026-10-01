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
const switches: Array<{ kind: string; enabled: boolean; response: ReturnType<typeof deferred<Response>> }> = [];
const switchRequest =
  (enabled: boolean) =>
  ({ param }: { param: { kind: string } }) => {
    const response = deferred<Response>();
    switches.push({ kind: param.kind, enabled, response });
    return response.promise;
  };
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
        "virtual-columns": { ":kind": { $put: switchRequest(true), $delete: switchRequest(false) } },
      },
    },
  }));
}

/** Flips a switch the way the browser does: the checkbox changes, then fires `change`. */
const flip = (input: HTMLInputElement) => {
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

/** The text of the status list alone; the automatic-column switches above it name the same columns. */
const listText = (root: HTMLElement) => root.querySelector(".k2b-settings-collection__list")!.textContent!;

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
    expect(listText(dom.root).indexOf("Done")).toBeLessThan(listText(dom.root).indexOf("Open"));

    requests[0]!.response.resolve(new Response(null, { status: 200 }));
    await flush();
    expect(listText(dom.root).indexOf("Done")).toBeLessThan(listText(dom.root).indexOf("Open"));
    reconciliation.resolve();
    await flush();
    expect(listText(dom.root).indexOf("Open")).toBeLessThan(listText(dom.root).indexOf("Done"));

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
    expect(listText(dom.root).indexOf("Overdue")).toBeLessThan(listText(dom.root).indexOf("Open"));

    dispose();
    dom.cleanup();
  });

  test("a switch changes the list at once, sits above it, and holds reordering until the change is saved", async () => {
    requests.length = 0;
    switches.length = 0;
    const dom = createDomTestHarness();
    const reconciliation = deferred<void>();
    const { StatusesSection } = await import("../src/frontend/[id]/_components/edit/StatusesSection");
    const dispose = render(
      () =>
        createComponent(StatusesSection, {
          spaceId: SPACE_ID,
          columns,
          virtualColumns: [{ kind: "blocked", rank: "1536" }],
          onDirtyChange: () => undefined,
          onSettingsChange: () => reconciliation.promise,
        }),
      dom.root,
    );
    const list = dom.root.querySelector(".k2b-settings-collection__list")!;
    const switchFor = (label: string) =>
      Array.from(dom.root.querySelectorAll<HTMLInputElement>('input[role="switch"]')).find((input) =>
        input.closest("label")!.textContent!.includes(label),
      )!;
    // Rows the switches add or remove sit below them, so a switch never moves under the pointer.
    expect(switchFor("Blocked").compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    flip(switchFor("Blocked"));
    expect(listText(dom.root)).not.toContain("Blocked");
    await flush();
    expect(switches.map(({ kind, enabled }) => [kind, enabled])).toEqual([["blocked", false]]);
    const moveDoneUp = () => dom.root.querySelector<HTMLButtonElement>('[aria-label="Move Done up"]')!;
    expect(moveDoneUp().disabled).toBe(true);
    moveDoneUp().click();
    expect(requests).toHaveLength(0);

    switches[0]!.response.resolve(new Response(JSON.stringify([]), { status: 200 }));
    await flush();
    // Saved but not yet reloaded: the list still leaves Blocked out, so a reorder never names it.
    expect(listText(dom.root)).not.toContain("Blocked");
    moveDoneUp().click();
    expect(requests.map((request) => request.columnIds)).toEqual([[columns[1]!.id, columns[0]!.id]]);

    reconciliation.resolve();
    dispose();
    dom.cleanup();
  });

  test("a switched-on column joins the list in front of the first done status right away", async () => {
    switches.length = 0;
    const dom = createDomTestHarness();
    const { StatusesSection } = await import("../src/frontend/[id]/_components/edit/StatusesSection");
    const dispose = render(
      () => createComponent(StatusesSection, { spaceId: SPACE_ID, columns, virtualColumns: [], onDirtyChange: () => undefined }),
      dom.root,
    );
    flip(
      Array.from(dom.root.querySelectorAll<HTMLInputElement>('input[role="switch"]')).find((input) =>
        input.closest("label")!.textContent!.includes("Overdue"),
      )!,
    );
    const text = listText(dom.root);
    expect(text.indexOf("Open")).toBeLessThan(text.indexOf("Overdue"));
    expect(text.indexOf("Overdue")).toBeLessThan(text.indexOf("Done"));

    await flush();
    switches[0]!.response.resolve(new Response(JSON.stringify([]), { status: 200 }));
    dispose();
    dom.cleanup();
  });
});
