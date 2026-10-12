import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";

describe("mail container switcher loader", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const payload = [
    { id: "Box001", name: "Support", receivingAddress: "help@example.test" },
    { id: "Box002", name: "Sales", receivingAddress: "sales@example.test" },
  ];
  const success = () => ({ ok: true, json: async () => payload });
  type Reply = ReturnType<typeof success>;
  let reply: () => Promise<Reply> = async () => success();
  const navigateTo = mock((_href: string) => {});
  mock.module("@k2b/ssr/nav", () => ({ ...navigation, navigateTo }));
  const post = mock(async (_input: unknown) => ({ ok: true, json: async () => ({ id: "Created01" }) }));
  const get = mock(() => reply());
  mock.module("../../api/client", () => ({ apiClient: { mailboxes: { $get: get, $post: post } } }));
  const settings = mock(async (_props: unknown) => ({ deleted: false }));
  mock.module("./MailboxSettingsDialog", () => ({ openMailboxSettingsDialog: settings }));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const mount = async (canCreate = false) => {
    const { createMailboxSwitcher } = await import("./mailbox-switcher");
    return createRoot((dispose) => ({
      switcher: createMailboxSwitcher(() => ({ id: "Box001", name: "Support", address: "help@example.test" }), canCreate, {
        currentUserEmail: "owner@example.test",
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      }),
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
    settings.mockClear();
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
      expect(view.switcher().options?.[0]?.href).toBe("/app/mail/Box001");
      expect(view.switcher().currentId).toBe("Box001");
      const { AppWorkspace } = await import("@k2b/ui");
      disposeRender = render(() => createComponent(AppWorkspace.SidebarSwitcher, view.switcher()), dom.root);
      expect(dom.root.querySelector('[data-switcher-option][aria-current="true"]')?.getAttribute("href")).toBe("/app/mail/Box001");
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

  test("offers creation only for a user-backed actor, before All", async () => {
    const allowed = await mount(true);
    const denied = await mount(false);
    try {
      expect(allowed.switcher().actions?.map((action) => action.id)).toEqual(["new", "all"]);
      expect(allowed.switcher().actions?.[0]?.label).toBe("New mailbox");
      expect(denied.switcher().actions?.map((action) => action.id)).toEqual(["all"]);
    } finally {
      allowed.dispose();
      denied.dispose();
    }
  });

  test("opens the shared blank form once and navigates after creation", async () => {
    const { prompts, dialogCore } = await import("@k2b/ui");
    let disposeRender: (() => void) | undefined;
    const form = spyOn(prompts, "form");
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
      expect(form).toHaveBeenCalledTimes(1);
      expect(form.mock.calls[0]?.[0]?.title).toBe("New mailbox");
      const name = dom.root.querySelector<HTMLInputElement>("input[type=text]")!;
      name.value = "New container";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      const description = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
      description.value = "Description";
      description.dispatchEvent(new Event("input", { bubbles: true }));
      dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let attempt = 0; attempt < 30 && navigateTo.mock.calls.length === 0; attempt++) await settle();
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0]?.[0]).toEqual({ json: { name: "New container", description: "Description" } });
      expect(navigateTo).toHaveBeenCalledWith("/app/mail/Created01");
      expect(settings).toHaveBeenCalledWith({
        mailboxId: "Created01",
        currentUserEmail: "owner@example.test",
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        initialTab: "delivery",
      });
      expect(view.switcher().actions?.[0]?.disabled).toBe(false);
    } finally {
      disposeRender?.();
      open.mockRestore();
      form.mockRestore();
      view.dispose();
    }
  });

  test("cancelling creation makes no request and enables the action again", async () => {
    const { prompts } = await import("@k2b/ui");
    const form = spyOn(prompts, "form").mockResolvedValue(null);
    const view = await mount(true);
    try {
      view.switcher().actions?.[0]?.action?.();
      for (let attempt = 0; attempt < 30 && view.switcher().actions?.[0]?.disabled; attempt++) await settle();
      expect(form).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
      expect(navigateTo).not.toHaveBeenCalled();
      expect(view.switcher().actions?.[0]?.disabled).toBe(false);
    } finally {
      form.mockRestore();
      view.dispose();
    }
  });
});
