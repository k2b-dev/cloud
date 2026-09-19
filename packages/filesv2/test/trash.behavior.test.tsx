import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
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

describe("trash view pagination and request identity", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    pending.length = 0;
  });
  const mount = async () => {
    const dom = createDomTestHarness();
    const { default: TrashView } = await import("../src/frontend/TrashView");
    const [current, setCurrent] = createSignal(base);
    const dispose = render(
      () =>
        createComponent(TrashView, {
          get base() {
            return current();
          },
          onRestored: () => {},
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    return { dom, setCurrent, dispose };
  };
  test("shows unknown filesystem metadata honestly and appends cursor pages once", async () => {
    const { dom } = await mount();
    pending[0]!.resolve(Response.json({ base, entries: [entry("first")], next: "cursor" }));
    await flush();
    expect(dom.root.textContent).toContain("Original location unknown");
    expect(dom.root.textContent).toContain("Deletion time unknown");
    const more = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Show more"));
    expect(more).toBeDefined();
    more!.click();
    await flush();
    expect(pending[1]?.after).toBe("cursor");
    pending[1]!.resolve(Response.json({ base, entries: [entry("first"), entry("second")], next: null }));
    await flush();
    expect(dom.root.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(dom.root.textContent).not.toContain("Show more");
  });
  test("changing storage aborts its old request and ignores its late result", async () => {
    const { dom, setCurrent } = await mount();
    setCurrent({ ...base, id: "cloud:groups:staff", name: "Staff", kind: "groups" });
    await flush();
    expect(pending[0]?.signal?.aborted).toBeTrue();
    pending[1]!.resolve(Response.json({ base: { ...base, id: "cloud:groups:staff" }, entries: [entry("staff")], next: null }));
    await flush();
    pending[0]!.resolve(Response.json({ base, entries: [entry("alice-private")], next: null }));
    await flush();
    expect(dom.root.textContent).toContain("staff.txt");
    expect(dom.root.textContent).not.toContain("alice-private.txt");
  });
  test("pending effects are explained and cannot be restored as if completed", async () => {
    const { dom } = await mount();
    pending[0]!.resolve(
      Response.json({ base, entries: [{ ...entry("pending"), state: "pending", error: "operation_unresolved" }], next: null }),
    );
    await flush();
    expect(dom.root.textContent).toContain("This move has not been confirmed");
    const restore = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Restore");
    expect(restore?.disabled).toBeTrue();
  });
  test("a changed location for the same logical base discards prior pages and cursors", async () => {
    const { dom, setCurrent } = await mount();
    pending[0]!.resolve(Response.json({ base, entries: [entry("old-server")], next: "old-cursor" }));
    await flush();
    [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Show more"))!.click();
    await flush();
    setCurrent({ ...base, locationKey: "new-server-root-prefix-binding" });
    await flush();
    expect(pending[1]?.signal?.aborted).toBeTrue();
    expect(pending[2]?.baseId).toBe(base.id);
    expect(pending[2]?.after).toBeUndefined();
    pending[2]!.resolve(Response.json({ base, entries: [entry("new-server")], next: null }));
    await flush();
    expect(dom.root.textContent).not.toContain("old-server.txt");
    expect(dom.root.textContent).toContain("new-server.txt");
  });
});
