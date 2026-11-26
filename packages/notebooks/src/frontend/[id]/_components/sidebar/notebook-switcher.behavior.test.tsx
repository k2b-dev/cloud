import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
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
  const navigateTo = mock((_href: string) => {});
  mock.module("@k2b/ssr/nav", () => ({ ...navigation, navigateTo }));
  const post = mock(async (_input: unknown) => ({ ok: true, json: async () => ({ id: "Created01" }) }));
  const get = mock((_input: { query: Record<string, string> }) => reply());
  mock.module("@/api/client", () => ({ apiClient: { index: { $get: get, $post: post } } }));
  // the dialog itself is the start page's (its browser test covers it); here it only records how it was opened
  const openDialog = mock(async (_source: { kind: string }, _locale: string, _signal?: AbortSignal) => {});
  mock.module("../../../create-notebook-dialog", () => ({ openNewNotebookDialog: openDialog }));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const mount = async (canCreate = false) => {
    const { createNotebookSwitcher } = await import("./notebook-switcher");
    return createRoot((dispose) => ({
      switcher: createNotebookSwitcher(() => ({ id: "Book01", name: "Handbook", icon: "ti-book" }), canCreate),
      dispose,
    }));
  };
  // The switchers read the document's language, so every test runs in a document.
  let dom: DomTestHarness;
  afterEach(() => dom.cleanup());
  beforeEach(() => {
    dom = createDomTestHarness();
    get.mockClear();
    post.mockClear();
    navigateTo.mockClear();
    openDialog.mockClear();
    reply = async () => success();
  });

  test("switcher labels match the overview in English and German", async () => {
    for (const { locale, expected } of [
      { locale: "en", expected: { switchLabel: "Switch notebook", actions: ["New notebook", "Notebook from a template"] } },
      { locale: "de", expected: { switchLabel: "Notizbuch wechseln", actions: ["Neues Notizbuch", "Notizbuch aus Vorlage"] } },
    ]) {
      dom.document.documentElement.lang = locale;
      const view = await mount(true);
      try {
        const { switchLabel, actions } = view.switcher();
        expect({ switchLabel, actions: actions?.map((action) => action.label) }).toEqual(expected);
      } finally {
        view.dispose();
      }
    }
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

  test("offers creation, blank or from a template, only for a user-backed actor, and no overview", async () => {
    const allowed = await mount(true);
    const denied = await mount(false);
    try {
      expect(allowed.switcher().actions?.map((action) => action.id)).toEqual(["new", "template"]);
      expect(allowed.switcher().actions?.[0]?.label).toBe("New notebook");
      expect(denied.switcher().actions ?? []).toEqual([]);
    } finally {
      allowed.dispose();
      denied.dispose();
    }
  });

  test("both actions open the start page's one dialog, blank or from a template, and wait until it closes", async () => {
    const view = await mount(true);
    try {
      for (const [index, kind] of [
        [0, "blank"],
        [1, "template"],
      ] as const) {
        const closed = Promise.withResolvers<void>();
        openDialog.mockImplementationOnce(() => closed.promise);
        view.switcher().actions?.[index]?.action?.();
        view.switcher().actions?.[index]?.action?.();
        for (let attempt = 0; attempt < 30 && openDialog.mock.calls.length <= index; attempt++) await settle();
        // one dialog at a time: both actions wait while it is open
        expect(openDialog.mock.calls[index]?.slice(0, 2)).toEqual([{ kind }, "en"]);
        expect(view.switcher().actions?.map((action) => action.disabled)).toEqual([true, true]);
        closed.resolve();
        for (let attempt = 0; attempt < 30 && view.switcher().actions?.[index]?.disabled; attempt++) await settle();
        expect(view.switcher().actions?.map((action) => action.disabled)).toEqual([false, false]);
      }
      expect(openDialog).toHaveBeenCalledTimes(2);
      expect(post).not.toHaveBeenCalled();
      // the dialog closes with the switcher, so a soft navigation leaves no dialog behind
      const signal = openDialog.mock.calls[0]?.[2];
      expect(signal?.aborted).toBe(false);
      view.dispose();
      expect(signal?.aborted).toBe(true);
    } finally {
      view.dispose();
    }
  });
});
