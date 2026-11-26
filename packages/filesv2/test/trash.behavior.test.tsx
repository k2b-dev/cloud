import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createSignal, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { BaseSummary, TrashEntry } from "../src/contracts";

const pending: { baseId: string; after?: string; signal?: AbortSignal; resolve: (response: Response) => void }[] = [];
if (!isServer)
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        ":baseId": {
          trash: {
            $get: (input: { param: { baseId: string }; query: { after?: string } }, options: { init: { signal: AbortSignal } }) =>
              new Promise<Response>((resolve) =>
                pending.push({ baseId: input.param.baseId, after: input.query.after, signal: options.init.signal, resolve }),
              ),
          },
        },
      },
    },
  }));
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
const base: BaseSummary = {
  id: "cloud:users:alice",
  area: "cloud",
  kind: "users",
  name: "Alice",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const entry = (id: string): TrashEntry => ({ id, name: `${id}.txt`, original: null, directory: false, deletedAt: null, state: "trashed" });
const names = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-k2-part="Table"] tbody tr')].map((row) => row.querySelector("td")?.textContent ?? "");

describe("the v2 trash pane: pages and storage identity", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    pending.length = 0;
  });
  /** The pane as the folder screen places it: one pane per storage, made again when the storage or its place changes. */
  const mount = async (initial: { entries: TrashEntry[]; next: string | null } | null) => {
    const dom = createDomTestHarness();
    const { default: TrashPane } = await import("../src/frontend/TrashPane");
    const [current, setCurrent] = createSignal(base);
    const [first, setFirst] = createSignal(initial);
    const dispose = render(
      () =>
        createComponent(Show, {
          get when() {
            return current();
          },
          keyed: true,
          children: (shown: BaseSummary) =>
            createComponent(TrashPane, {
              base: shown,
              initial: first(),
              timeZone: "Europe/Berlin",
              onRestored: () => {},
              onNavigate: () => {},
            }),
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    return { dom, setCurrent, setFirst };
  };

  test("the server's first page stands without a request, says what is unknown, and appends the next page once", async () => {
    const { dom } = await mount({ entries: [entry("first")], next: "cursor" });
    expect(pending).toHaveLength(0);
    expect(dom.root.textContent).toContain("Original location unknown");
    expect(dom.root.textContent).toContain("Deletion time unknown");
    const more = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Load more"));
    expect(more).toBeDefined();
    more!.click();
    await flush();
    expect(pending[0]?.after).toBe("cursor");
    pending[0]!.resolve(Response.json({ base, entries: [entry("first"), entry("second")], next: null }));
    await flush();
    expect(names(dom.root)).toHaveLength(2);
    expect(dom.root.textContent).not.toContain("Load more");
  });

  test("another storage starts a new pane: its old request ends and a late result shows nothing", async () => {
    const { dom, setCurrent, setFirst } = await mount({ entries: [entry("alice")], next: "cursor" });
    [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Load more"))!.click();
    await flush();
    setFirst({ entries: [entry("staff")], next: null });
    setCurrent({ ...base, id: "cloud:groups:staff", name: "Staff", kind: "groups" });
    await flush();
    expect(pending[0]?.signal?.aborted).toBeTrue();
    pending[0]!.resolve(Response.json({ base, entries: [entry("alice-private")], next: null }));
    await flush();
    expect(dom.root.textContent).toContain("staff.txt");
    expect(dom.root.textContent).not.toContain("alice-private.txt");
  });

  test("an unconfirmed move is explained and cannot be restored as if it were done", async () => {
    const { dom } = await mount({ entries: [{ ...entry("pending"), state: "pending", error: "operation_unresolved" }], next: null });
    expect(dom.root.textContent).toContain("This move has not been confirmed");
    const restore = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Restore");
    expect(restore?.disabled).toBeTrue();
  });

  test("a trash the server could not read offers Try again, which reads the first page", async () => {
    const { dom } = await mount(null);
    dom.root.querySelector<HTMLButtonElement>('[data-k2-part="Failed"] button')!.click();
    await flush();
    expect(pending[0]?.after).toBeUndefined();
    pending[0]!.resolve(Response.json({ base, entries: [entry("back")], next: null }));
    await flush();
    expect(dom.root.textContent).toContain("back.txt");
  });
});
