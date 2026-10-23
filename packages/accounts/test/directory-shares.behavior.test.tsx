import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const accountId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const waitFor = async (predicate: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected directory UI state did not arrive");
};

// Happy DOM lacks the native popover API. Browser tests cover its actual behavior.
const createDirectoryDom = () => {
  const dom = createDomTestHarness();
  const open = new WeakSet<HTMLElement>();
  const prototype = HTMLElement.prototype;
  const matches = prototype.matches;
  const toggle = (element: HTMLElement, newState: "open" | "closed") =>
    element.dispatchEvent(Object.assign(new Event("toggle"), { newState, oldState: newState === "open" ? "closed" : "open" }));
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
  });
  prototype.showPopover = function () {
    if (open.has(this)) return;
    open.add(this);
    toggle(this, "open");
  };
  prototype.hidePopover = function () {
    if (open.delete(this)) toggle(this, "closed");
  };
  delegateEvents(["click", "input", "keydown", "pointerdown", "pointermove"]);
  return dom;
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("../src/frontend/service-accounts/DirectoryShares.island");
  } finally {
    dom.cleanup();
  }
};
const components = isServer ? null : await load();
describe("directory share administration", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());
  test("shares a named entry, retains a failed change for retry, then revokes it", async () => {
    const dom = createDirectoryDom();
    const requests: string[] = [];
    let granted = false;
    let failGrant = true;
    const network = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname.endsWith("/service-accounts"))
        return Response.json({ items: [{ id: accountId, name: "Release helper", kind: "agent" }] });
      if (url.pathname.endsWith("/entities"))
        return Response.json({
          items: [{ id: personId, kind: "user", user: { id: personId, uid: "ada", displayName: "Ada Example", avatarHash: null } }],
        });
      if (url.pathname.includes("/directory-shares/")) {
        if (method === "POST") {
          if (failGrant) return Response.json({ message: "Temporary failure" }, { status: 503 });
          granted = true;
          return Response.json({ id: "share-one" }, { status: 201 });
        }
        if (method === "DELETE") {
          granted = false;
          return Response.json({ ok: true });
        }
        return Response.json({
          items: granted
            ? [{ id: "share-one", label: "Ada Example", principal: { type: "user", userId: personId }, serviceAccountKind: null }]
            : [],
          total: granted ? 1 : 0,
          page: 1,
          perPage: 20,
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    });
    const { DirectorySharesDialog } = components!;
    const dispose = render(() => createComponent(DirectorySharesDialog, { close: () => {}, setDismissHandler: () => {} }), dom.root);
    cleanup = () => {
      dispose();
      network.mockRestore();
      dom.cleanup();
    };
    const input = () => dom.document.querySelectorAll<HTMLInputElement>('input[role="combobox"]');
    const type = async (field: HTMLInputElement, value: string) => {
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    };
    const option = (label: string) =>
      [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes(label));
    await type(input()[0]!, "Release");
    await waitFor(() => Boolean(option("Release helper")));
    expect(option("Release helper")).toBeDefined();
    option("Release helper")!.click();
    await flush();
    expect(dom.root.textContent).toContain("No entries shared");
    await type(input()[1]!, "Ada");
    await waitFor(() => Boolean(option("Ada Example")));
    option("Ada Example")!.click();
    await flush();
    expect(dom.root.textContent).toContain("Could not update directory access");
    expect(dom.root.textContent).toContain("Release helper");
    failGrant = false;
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Retry")!.click();
    await flush();
    expect(dom.root.textContent).toContain("Ada Example");
    const revoke = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Revoke directory access: Ada Example"]');
    expect(revoke).not.toBeNull();
    revoke!.click();
    await flush();
    expect(dom.root.textContent).toContain("No entries shared");
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(2);
    expect(requests.filter((request) => request.startsWith("DELETE "))).toHaveLength(1);
  });
  test("a failed recipient switch never displays the previous recipient's entries", async () => {
    const dom = createDirectoryDom();
    const secondId = "33333333-3333-4333-8333-333333333333";
    let secondFails = true;
    let release: ((value: Response) => void) | undefined;
    const network = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      if (url.pathname.endsWith("/service-accounts"))
        return Response.json({
          items: [
            { id: accountId, name: "First helper", kind: "agent" },
            { id: secondId, name: "Second helper", kind: "standalone" },
          ],
        });
      if (url.pathname.includes(secondId)) {
        if (secondFails) return Response.json({ message: "Unavailable" }, { status: 503 });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url.pathname.includes("/directory-shares/"))
        return Response.json({
          items: [
            { id: "first-share", label: "First private entry", principal: { type: "user", userId: personId }, serviceAccountKind: null },
          ],
          total: 1,
          page: 1,
          perPage: 20,
        });
      throw new Error("Unexpected fixture path");
    });
    const dispose = render(
      () => createComponent(components!.DirectorySharesDialog, { close: () => {}, setDismissHandler: () => {} }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      network.mockRestore();
      dom.cleanup();
    };
    const select = async (name: string) => {
      const field = dom.document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      field.value = name;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      await waitFor(() => [...dom.document.querySelectorAll('[role="option"]')].some((node) => node.textContent?.includes(name)));
      [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes(name))!.click();
      await flush();
    };
    await select("First helper");
    expect(dom.root.textContent).toContain("First private entry");
    await select("Second helper");
    expect(dom.root.textContent).not.toContain("First private entry");
    expect(dom.root.textContent).toContain("Could not load directory access");
    secondFails = false;
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Retry")!.click();
    await flush();
    expect(dom.root.textContent).not.toContain("First private entry");
    release!(Response.json({ items: [], total: 0, page: 1, perPage: 20 }));
    await flush();
    expect(dom.root.textContent).toContain("No entries shared");
    expect(dom.root.textContent).not.toContain("First private entry");
  });
  test("revoking share 21 on page two returns to the remaining twenty entries", async () => {
    const dom = createDirectoryDom();
    let total = 21;
    const network = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname.endsWith("/service-accounts"))
        return Response.json({ items: [{ id: accountId, name: "Release helper", kind: "agent" }] });
      if (method === "DELETE") {
        total = 20;
        return Response.json({ ok: true });
      }
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({
        items: Array.from({ length: page === 1 ? 20 : total - 20 }, (_, n) => ({
          id: `share-${(page - 1) * 20 + n}`,
          label: `Entry ${(page - 1) * 20 + n + 1}`,
          principal: { type: "user", userId: personId },
          serviceAccountKind: null,
        })),
        total,
        page,
        perPage: 20,
      });
    });
    const dispose = render(
      () => createComponent(components!.DirectorySharesDialog, { close: () => {}, setDismissHandler: () => {} }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      network.mockRestore();
      dom.cleanup();
    };
    const field = dom.document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    field.value = "Release";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => [...dom.document.querySelectorAll('[role="option"]')].some((n) => n.textContent?.includes("Release helper")));
    [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((n) => n.textContent?.includes("Release helper"))!
      .click();
    await waitFor(() => Boolean(dom.root.querySelector('button[aria-label="Revoke directory access: Entry 1"]')));
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((n) => n.textContent?.trim() === "Next")!.click();
    await waitFor(() => Boolean(dom.root.querySelector('button[aria-label="Revoke directory access: Entry 21"]')));
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Revoke directory access: Entry 21"]')!.click();
    await waitFor(() => Boolean(dom.root.querySelector('button[aria-label="Revoke directory access: Entry 1"]')));
    expect(dom.root.querySelectorAll('button[aria-label^="Revoke directory access:"]')).toHaveLength(20);
    expect(dom.root.textContent).not.toContain("No entries shared");
  });
});
