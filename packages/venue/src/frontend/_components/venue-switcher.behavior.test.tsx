import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

describe("venue container switcher loader", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const payload = {
    venues: [
      { id: "Cafe01", name: "Corner Café", icon: "ti ti-coffee", accentColor: "#2563eb" },
      { id: "Desk01", name: "Service desk", icon: "ti ti-building", accentColor: "#6366f1" },
    ],
  };
  const success = () => ({ ok: true, json: async () => payload });
  type Reply = ReturnType<typeof success>;
  let reply: () => Promise<Reply> = async () => success();
  const get = mock(() => reply());
  mock.module("../../api/client", () => ({ apiClient: { venues: { $get: get } } }));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const mount = async () => {
    const { createVenueSwitcher } = await import("./venue-switcher");
    return createRoot((dispose) => ({
      switcher: createVenueSwitcher(() => ({ id: "Cafe01", name: "Corner Café", icon: "ti ti-coffee", accentColor: "#2563eb" }), false),
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
      expect(view.switcher().options?.[0]?.href).toBe("/app/venue/Cafe01");
      expect(view.switcher().currentId).toBe("Cafe01");
      const { AppWorkspace } = await import("@k2b/ui");
      disposeRender = render(() => createComponent(AppWorkspace.SidebarSwitcher, view.switcher()), dom.root);
      expect(dom.root.querySelector('[data-switcher-option][aria-current="true"]')?.getAttribute("href")).toBe("/app/venue/Cafe01");
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
  test("offers New venue only with known permission to create", async () => {
    const { createVenueSwitcher } = await import("./venue-switcher");
    const current = () => ({ id: "Cafe01", name: "Corner Café", icon: "ti ti-coffee", accentColor: "#2563eb" });
    const view = createRoot((dispose) => ({
      allowed: createVenueSwitcher(current, true),
      denied: createVenueSwitcher(current, false),
      dispose,
    }));
    try {
      expect(view.allowed().actions?.map((action) => action.id)).toEqual(["new", "all"]);
      expect(view.denied().actions?.map((action) => action.id)).toEqual(["all"]);
    } finally {
      view.dispose();
    }
  });
});
