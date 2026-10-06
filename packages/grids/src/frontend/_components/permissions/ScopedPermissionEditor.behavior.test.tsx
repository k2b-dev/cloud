import { expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts/shared";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** happy-dom has no Popover API; the level menus open through it. */
const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const open = new WeakSet<object>();
  const matches = prototype.matches as (this: Element, selector: string) => boolean;
  Object.assign(prototype, {
    matches(this: Element, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
    showPopover(this: object) {
      open.add(this);
    },
    hidePopover(this: object) {
      open.delete(this);
    },
    scrollIntoView() {},
  });
};

const manager = (id: string, displayName: string): AccessEntry => ({
  id,
  principal: { type: "user", userId: `user-${id}` },
  permission: "admin",
  createdAt: "2026-10-06T00:00:00.000Z",
  displayName,
});

domTest("the base access editor turns read-only once a change costs the person Manage access", async () => {
  const dom = createDomTestHarness();
  installPopoverApi(dom);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
      requests.push(`${method} ${new URL(url, "http://cloud.test").pathname}`);
      // Lowering their own entry left the person with Edit, and only managers may list the entries.
      if (method === "PATCH") return new Response(null, { status: 204 });
      return Response.json({ message: "You no longer have administrator access to this Base." }, { status: 403 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { ScopedPermissionEditor } = await import("./ScopedPermissionEditor");
  delegateEvents(["click"]);
  const dispose = render(
    () => (
      <ScopedPermissionEditor
        scope={{ type: "base", id: "BASE01" }}
        initialEntries={[manager("qdt", "Quentin Dorn"), manager("lym", "Lya Meyer")]}
        canEdit
      />
    ),
    dom.root,
  );
  const rowOf = (name: string) =>
    Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes(name))!;
  const removeButtons = () => dom.root.querySelectorAll("button[aria-label^='Remove ']");
  try {
    expect(removeButtons()).toHaveLength(2);
    const edit = Array.from(rowOf("Quentin Dorn").querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")).find((item) =>
      item.textContent?.startsWith("Edit"),
    )!;
    edit.click();

    await waitFor(() => removeButtons().length === 0, "the read-only editor");
    expect(requests).toEqual(["PATCH /api/grids/access/qdt", "GET /api/grids/access/by-base/BASE01"]);
    expect(rowOf("Quentin Dorn").querySelector("[role=menuitemradio]")).toBeNull();
    expect(rowOf("Quentin Dorn").textContent).toContain("Edit");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
