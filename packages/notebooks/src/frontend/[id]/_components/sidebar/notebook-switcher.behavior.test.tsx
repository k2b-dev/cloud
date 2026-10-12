import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";

describe("notebooks container switcher loader", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const payload = {
    data: [
      { id: "Book01", name: "Handbook", icon: "ti-book" },
      { id: "Book02", name: "Recipes", icon: null },
    ],
    pagination: { total_pages: 1, has_next: false },
  };
  const success = () => ({ ok: true, json: async () => payload });
  type Reply = ReturnType<typeof success>;
  let reply: () => Promise<Reply> = async () => success();
  const get = mock((_input: { query: Record<string, string> }) => reply());
  mock.module("@/api/client", () => ({ apiClient: { index: { $get: get } } }));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const mount = async () => {
    const { createNotebookSwitcher } = await import("./notebook-switcher");
    return createRoot((dispose) => ({
      switcher: createNotebookSwitcher(() => ({ id: "Book01", name: "Handbook", icon: "ti-book" })),
      dispose,
    }));
  };
  // The switchers read the document's language, so every test runs in a document.
  let dom: DomTestHarness;
  afterEach(() => dom.cleanup());
  beforeEach(() => {
    dom = createDomTestHarness();
    get.mockClear();
    reply = async () => success();
  });

  test("loads accessible options once and marks the open container", async () => {
    const view = await mount();
    let disposeRender: (() => void) | undefined;
    try {
      expect(view.switcher().options).toBeUndefined();
      view.switcher().onLoad?.();
      view.switcher().onLoad?.();
      await settle();
      expect(get).toHaveBeenCalledTimes(1);
      expect(view.switcher().options).toHaveLength(2);
      expect(view.switcher().options?.[0]?.href).toBe("/app/notebooks/Book01");
      expect(view.switcher().currentId).toBe("Book01");
      const { AppWorkspace } = await import("@k2b/ui");
      disposeRender = render(() => createComponent(AppWorkspace.SidebarSwitcher, view.switcher()), dom.root);
      expect(dom.root.querySelector('[data-switcher-option][aria-current="true"]')?.getAttribute("href")).toBe("/app/notebooks/Book01");
      expect(dom.root.querySelectorAll('[data-switcher-option][aria-current="true"]')).toHaveLength(1);
      view.switcher().onLoad?.();
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      disposeRender?.();
      view.dispose();
    }
  });

  test("ignores repeated requests in flight and retries after a failure", async () => {
    const pending = Promise.withResolvers<Reply>();
    reply = () => pending.promise;
    const view = await mount();
    try {
      view.switcher().onLoad?.();
      view.switcher().onLoad?.();
      expect(get).toHaveBeenCalledTimes(1);
      pending.reject(new Error("Unavailable"));
      await settle();
      expect(view.switcher().options).toBeUndefined();
      expect(view.switcher().error).toBeTruthy();
      reply = async () => success();
      view.switcher().onLoad?.();
      expect(view.switcher().error).toBeUndefined();
      await settle();
      expect(get).toHaveBeenCalledTimes(2);
      expect(view.switcher().options).toHaveLength(2);
      expect(view.switcher().error).toBeUndefined();
    } finally {
      view.dispose();
    }
  });
  test("uses the maximum page size and follows has_next", async () => {
    let page = 0;
    reply = async () => ({
      ok: true,
      json: async () => ({ ...payload, data: [payload.data[page++]!], pagination: { total_pages: 2, has_next: page === 1 } }),
    });
    const view = await mount();
    try {
      view.switcher().onLoad?.();
      await settle();
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls).toEqual([[{ query: { page: "1", per_page: "100" } }], [{ query: { page: "2", per_page: "100" } }]]);
      expect(view.switcher().options?.map((item) => item.id)).toEqual(["Book01", "Book02"]);
    } finally {
      view.dispose();
    }
  });
});
