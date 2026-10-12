import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

describe("grids container switcher loader", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const payload = {
    items: [
      { id: "BASE01", name: "Inventory" },
      { id: "BASE02", name: "Sales" },
    ],
    total: 2,
  };
  const success = () => ({ ok: true, json: async () => payload });
  type Reply = ReturnType<typeof success>;
  let reply: () => Promise<Reply> = async () => success();
  const get = mock((_input: { query: Record<string, string> }) => reply());
  mock.module("../../../api/client", () => ({ apiClient: { bases: { $get: get } } }));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const mount = async () => {
    const { createBaseSwitcher } = await import("./base-switcher");
    return createRoot((dispose) => ({ switcher: createBaseSwitcher(() => ({ id: "BASE01", name: "Inventory" })), dispose }));
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
      expect(view.switcher().options?.[0]?.href).toBe("/app/grids/BASE01");
      expect(view.switcher().currentId).toBe("BASE01");
      const { AppWorkspace } = await import("@k2b/ui");
      disposeRender = render(() => createComponent(AppWorkspace.SidebarSwitcher, view.switcher()), dom.root);
      expect(dom.root.querySelector('[data-switcher-option][aria-current="true"]')?.getAttribute("href")).toBe("/app/grids/BASE01");
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
  test("pages bases at the endpoint's maximum and stops at the total", async () => {
    let page = 0;
    reply = async () => ({ ok: true, json: async () => ({ items: [payload.items[page++]!], total: 501 }) });
    const view = await mount();
    try {
      view.switcher().onLoad?.();
      await settle();
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls).toEqual([[{ query: { limit: "500", offset: "0" } }], [{ query: { limit: "500", offset: "500" } }]]);
      expect(view.switcher().options?.map((item) => item.id)).toEqual(["BASE01", "BASE02"]);
    } finally {
      view.dispose();
    }
  });

  test("a list that grows while loading keeps the first response's page bound", async () => {
    let page = 0;
    reply = async () => ({ ok: true, json: async () => ({ ...payload, total: ++page === 1 ? 501 : 1001 }) });
    const view = await mount();
    try {
      view.switcher().onLoad?.();
      await settle();
      expect(get).toHaveBeenCalledTimes(2);
      expect(view.switcher().options).toHaveLength(4);
      expect(view.switcher().error).toBeUndefined();
    } finally {
      view.dispose();
    }
  });
});
