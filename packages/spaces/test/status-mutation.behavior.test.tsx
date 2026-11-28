import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn } from "@/contracts";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { installV2Globals, menuEntry } from "./v2-dom";

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

/** The section of the statuses; the automatic-column switches above it name the same columns. */
const statusList = (dom: DomTestHarness) => dom.document.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')[1]!;
const listText = (dom: DomTestHarness) => statusList(dom).textContent!;
/** The switch of an automatic column, by its name. */
const switchFor = (dom: DomTestHarness, label: string) =>
  Array.from(dom.document.querySelectorAll<HTMLInputElement>('input[role="switch"]')).find((input) =>
    input.closest('[data-k2-part="Row"]')!.textContent!.includes(label),
  )!;
/** Moves a status one place from its row's menu; resolves to whether the entry could be chosen. */
const move = async (dom: DomTestHarness, name: string, direction: "up" | "down") => {
  const entry = await menuEntry(dom, `More actions for ${name}`, direction === "up" ? "Move up" : "Move down");
  const enabled = entry?.getAttribute("aria-disabled") !== "true";
  entry?.click();
  // a refused entry leaves its menu open; Escape closes it the way a person would
  if (!enabled) dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  await Bun.sleep(10);
  return enabled;
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const mount = async (props: {
  virtualColumns: Array<{ kind: "blocked" | "overdue"; rank: string }>;
  onSettingsChange?: () => Promise<void>;
}) => {
  const dom = createDomTestHarness();
  installV2Globals(dom);
  const { StatusesSection } = await import("../src/frontend/[id]/_components/edit/StatusesSection");
  const dispose = render(
    () => createComponent(StatusesSection, { spaceId: SPACE_ID, columns, onDirtyChange: () => undefined, ...props }),
    dom.root,
  );
  return {
    dom,
    close: async () => {
      dispose();
      // a closing v2 menu finishes its focus work a moment later, while the window still exists
      await Bun.sleep(20);
      dom.cleanup();
    },
  };
};

describe("Spaces status mutations", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("takes one reorder at a time and releases its optimistic projection after canonical reconciliation", async () => {
    requests.length = 0;
    const reconciliation = deferred<void>();
    const { dom, close } = await mount({ virtualColumns: [], onSettingsChange: () => reconciliation.promise });

    expect(await move(dom, "Open", "down")).toBe(true);
    // While the first move is saved, the next one waits.
    expect(await move(dom, "Open", "down")).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.columnIds).toEqual([columns[1]!.id, columns[0]!.id]);
    expect(listText(dom).indexOf("Done")).toBeLessThan(listText(dom).indexOf("Open"));

    requests[0]!.response.resolve(new Response(null, { status: 200 }));
    await flush();
    expect(listText(dom).indexOf("Done")).toBeLessThan(listText(dom).indexOf("Open"));
    reconciliation.resolve();
    await flush();
    expect(listText(dom).indexOf("Open")).toBeLessThan(listText(dom).indexOf("Done"));
    await close();
  });

  test("orders an enabled automatic column with the statuses and names it by kind", async () => {
    requests.length = 0;
    const { dom, close } = await mount({ virtualColumns: [{ kind: "overdue", rank: "1536" }] });

    expect(await move(dom, "Overdue", "up")).toBe(true);
    expect(requests.map((request) => request.columnIds)).toEqual([["overdue", columns[0]!.id, columns[1]!.id]]);
    expect(listText(dom).indexOf("Overdue")).toBeLessThan(listText(dom).indexOf("Open"));
    await close();
  });

  test("a switch changes the list at once, sits above it, and holds reordering until the change is saved", async () => {
    requests.length = 0;
    switches.length = 0;
    const reconciliation = deferred<void>();
    const { dom, close } = await mount({
      virtualColumns: [{ kind: "blocked", rank: "1536" }],
      onSettingsChange: () => reconciliation.promise,
    });
    // Rows the switches add or remove sit below them, so a switch never moves under the pointer.
    expect(switchFor(dom, "Blocked").compareDocumentPosition(statusList(dom)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    flip(switchFor(dom, "Blocked"));
    expect(listText(dom)).not.toContain("Blocked");
    await flush();
    expect(switches.map(({ kind, enabled }) => [kind, enabled])).toEqual([["blocked", false]]);
    expect(await move(dom, "Done", "up")).toBe(false);
    expect(requests).toHaveLength(0);

    switches[0]!.response.resolve(new Response(JSON.stringify([]), { status: 200 }));
    await flush();
    // Saved but not yet reloaded: the list still leaves Blocked out, so a reorder never names it.
    expect(listText(dom)).not.toContain("Blocked");
    expect(await move(dom, "Done", "up")).toBe(true);
    expect(requests.map((request) => request.columnIds)).toEqual([[columns[1]!.id, columns[0]!.id]]);

    reconciliation.resolve();
    await close();
  });

  test("a switched-on column joins the list in front of the first done status right away", async () => {
    switches.length = 0;
    const { dom, close } = await mount({ virtualColumns: [] });
    flip(switchFor(dom, "Overdue"));
    const text = listText(dom);
    expect(text.indexOf("Open")).toBeLessThan(text.indexOf("Overdue"));
    expect(text.indexOf("Overdue")).toBeLessThan(text.indexOf("Done"));

    await flush();
    switches[0]!.response.resolve(new Response(JSON.stringify([]), { status: 200 }));
    await close();
  });
});
