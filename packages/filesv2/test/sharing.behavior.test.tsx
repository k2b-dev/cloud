import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PublicShare } from "../src/contracts";

const requests: Array<{ path: string; after?: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
if (!isServer)
  mock.module("../src/frontend/public-client", () => ({
    publicClient: {
      s: {
        ":token": {
          api: {
            $get: (input: { query: { path: string; after?: string } }, options: { init: { signal: AbortSignal } }) =>
              new Promise<Response>((resolve) => requests.push({ ...input.query, signal: options.init.signal, resolve })),
          },
        },
      },
    },
  }));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const initial: PublicShare = {
  kind: "download",
  title: "Shared",
  note: null,
  expiresAt: null,
  maxFileSize: 10,
  maxTotalSize: 100,
  showUploadNames: false,
  uploadedNames: [],
  path: "",
  next: null,
  items: [{ path: "Docs", name: "Docs", directory: true, size: 0 }],
};

describe("public folder navigation", () => {
  if (isServer) {
    test.skip("requires the DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
  });
  test("opens a shared folder, loads its next page and returns to the selection", async () => {
    const dom = createDomTestHarness();
    const { default: PublicShareList } = await import("../src/frontend/PublicShare.island");
    const dispose = render(() => createComponent(PublicShareList, { token: "test-token", share: initial }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const click = (name: string) => {
      const button = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes(name));
      expect(button).toBeDefined();
      button!.click();
    };
    click("Open folder");
    await flush();
    expect(requests[0]?.path).toBe("Docs");
    requests[0]!.resolve(
      Response.json({
        ...initial,
        path: "Docs",
        next: "cursor",
        items: [{ path: "Docs/a.txt", name: "a.txt", directory: false, size: 1 }],
      }),
    );
    await flush();
    expect(dom.root.textContent).toContain("a.txt");
    click("Load more");
    await flush();
    expect(requests[1]?.after).toBe("cursor");
    requests[1]!.resolve(
      Response.json({ ...initial, path: "Docs", items: [{ path: "Docs/b.txt", name: "b.txt", directory: false, size: 2 }] }),
    );
    await flush();
    expect(dom.root.textContent).toContain("a.txt");
    expect(dom.root.textContent).toContain("b.txt");
    click("Back");
    await flush();
    expect(requests[2]?.path).toBe("");
    requests[2]!.resolve(Response.json(initial));
    await flush();
    expect(dom.root.textContent).toContain("Docs");
    expect(dom.root.textContent).not.toContain("a.txt");
  });
  test("unmount aborts a pending folder request", async () => {
    const dom = createDomTestHarness();
    const { default: PublicShareList } = await import("../src/frontend/PublicShare.island");
    const dispose = render(() => createComponent(PublicShareList, { token: "test-token", share: initial }), dom.root);
    cleanup = () => dom.cleanup();
    [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Open folder"))!.click();
    await flush();
    dispose();
    expect(requests[0]?.signal.aborted).toBeTrue();
  });
  test("an expired public cursor discards old pages and retries the first page only once", async () => {
    const dom = createDomTestHarness();
    const { default: PublicShareList } = await import("../src/frontend/PublicShare.island");
    const dispose = render(
      () =>
        createComponent(PublicShareList, {
          token: "test-token",
          share: {
            ...initial,
            path: "Docs",
            next: "expired",
            items: [{ path: "Docs/old.txt", name: "old.txt", directory: false, size: 1 }],
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Load more"))!.click();
    await flush();
    requests[0]!.resolve(Response.json({ code: "cursor_invalid", message: "Changed" }, { status: 409 }));
    await flush();
    expect(requests[1]?.after).toBeUndefined();
    expect(requests[1]?.path).toBe("Docs");
    expect(dom.root.textContent).not.toContain("old.txt");
    requests[1]!.resolve(
      Response.json({ ...initial, path: "Docs", items: [{ path: "Docs/new.txt", name: "new.txt", directory: false, size: 2 }] }),
    );
    await flush();
    expect(dom.root.textContent).toContain("new.txt");
    expect(dom.root.textContent).toContain("This folder changed");
    expect(requests).toHaveLength(2);
  });
});
