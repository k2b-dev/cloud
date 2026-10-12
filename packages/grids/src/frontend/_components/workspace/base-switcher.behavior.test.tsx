import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
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
  const navigateTo = mock((_href: string) => {});
  mock.module("@k2b/ssr/nav", () => ({ ...navigation, navigateTo }));
  const post = mock(async (_input: unknown) => ({ ok: true, json: async () => ({ id: "Created01" }) }));
  const get = mock((_input: { query: Record<string, string> }) => reply());
  mock.module("../../../api/client", () => ({ apiClient: { bases: { $get: get, $post: post } } }));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const mount = async (canCreate = false) => {
    const { createBaseSwitcher } = await import("./base-switcher");
    return createRoot((dispose) => ({ switcher: createBaseSwitcher(() => ({ id: "BASE01", name: "Inventory" }), canCreate), dispose }));
  };
  // The switchers read the document's language, so every test runs in a document.
  let dom: DomTestHarness;
  afterEach(() => dom.cleanup());
  beforeEach(() => {
    dom = createDomTestHarness();
    get.mockClear();
    post.mockClear();
    navigateTo.mockClear();
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

  test("offers creation only for a user-backed actor, before All", async () => {
    const allowed = await mount(true);
    const denied = await mount(false);
    try {
      expect(allowed.switcher().actions?.map((action) => action.id)).toEqual(["new", "all"]);
      expect(allowed.switcher().actions?.[0]?.label).toBe("New base");
      expect(denied.switcher().actions?.map((action) => action.id)).toEqual(["all"]);
    } finally {
      allowed.dispose();
      denied.dispose();
    }
  });

  test("opens the shared blank dialog once and navigates after submission", async () => {
    const { dialogCore } = await import("@k2b/ui");
    let disposeRender: (() => void) | undefined;
    const open = spyOn(dialogCore, "open").mockImplementation(
      (content) =>
        new Promise((resolve) => {
          disposeRender = render(
            () =>
              content(resolve, {
                dialog: dom.document.createElement("dialog"),
                setModal: () => {},
                setPosition: () => {},
                setDismissHandler: () => {},
                requestDismiss: async () => {},
              }),
            dom.root,
          );
        }),
    );
    const view = await mount(true);
    try {
      const action = view.switcher().actions?.[0];
      action?.action?.();
      action?.action?.();
      expect(view.switcher().actions?.[0]?.disabled).toBe(true);
      for (let attempt = 0; attempt < 30 && !dom.root.querySelector("form"); attempt++) await settle();
      expect(open).toHaveBeenCalledTimes(1);
      const name = dom.root.querySelector<HTMLInputElement>("input[type=text]")!;
      expect(name.value).toBe("");
      name.value = "New container";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let attempt = 0; attempt < 30 && navigateTo.mock.calls.length === 0; attempt++) await settle();
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0]?.[0]).toEqual({ json: { name: "New container", description: null } });
      expect(navigateTo).toHaveBeenCalledWith("/app/grids/Created01");
      expect(view.switcher().actions?.[0]?.disabled).toBe(false);
    } finally {
      disposeRender?.();
      open.mockRestore();
      view.dispose();
    }
  });
});
