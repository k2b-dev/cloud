import { expect, spyOn, test } from "bun:test";
import type { AdminMailApp } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const open = new WeakSet<Element>();
  const patch = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
    Object.defineProperty(prototype, key, { configurable: true, writable: true, value });
  };
  const matches = prototype.matches;
  patch("matches", function (this: Element, selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  });
  patch("showPopover", function (this: HTMLElement) {
    open.add(this);
  });
  patch("hidePopover", function (this: HTMLElement) {
    open.delete(this);
  });
  patch("scrollIntoView", () => {});
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
  };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), LogAccessDialog: (await import("./OutgoingMail.island")).LogAccessDialog };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const flush = async () => {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
};
const app: AdminMailApp = {
  appId: "reader",
  name: "Reader",
  registered: true,
  declared: false,
  readDeclared: true,
  mode: "default",
  profiles: [],
  logApps: ["offline"],
  logContentApps: ["offline"],
};
const source: AdminMailApp = { ...app, appId: "source", name: "Source", logApps: [], logContentApps: [] };

if (isServer) test.skip("mail log access needs Solid DOM", () => {});
else
  test("three levels round-trip, offline content stays, failure preserves selection, cancel discards edits", async () => {
    const dom = createDomTestHarness();
    const restorePopover = installPopoverApi(dom);
    const { ui, LogAccessDialog } = modules!;
    delegateEvents(["click", "keydown", "input"]);
    const bodies: unknown[] = [];
    let respond = (_: Response) => {};
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
          bodies.push(await request.json());
          return new Promise<Response>((resolve) => {
            respond = resolve;
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    let saved = 0;
    let closed = 0;
    const dispose = render(
      () =>
        createComponent(ui.LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(LogAccessDialog, {
              app,
              apps: [app, source],
              close: () => {
                closed++;
              },
              onSaved: () => {
                saved++;
              },
            });
          },
        }),
      dom.root,
    );
    const submit = () =>
      dom.root
        .querySelector("form")!
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    const pick = async (label: string) => {
      const trigger = dom.root.querySelectorAll<HTMLButtonElement>("[role=combobox]")[1]!;
      trigger.focus();
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as KeyboardEvent);
      await flush();
      const listbox = dom.document.getElementById(trigger.getAttribute("aria-controls")!)!;
      const option = [...listbox.querySelectorAll<HTMLButtonElement>("[role=option]")].find(
        (option) => option.textContent?.trim() === label,
      )!;
      expect(option).toBeDefined();
      for (let step = 0; step < 3 && option.dataset.focused !== "true"; step++)
        trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as KeyboardEvent);
      expect(option.dataset.focused).toBe("true");
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as KeyboardEvent);
      await flush();
      expect(dom.document.activeElement).toBe(trigger);
    };
    try {
      expect(dom.root.textContent).toContain("offline · Not registered");
      expect(dom.root.querySelectorAll("[role=combobox]")[0]?.textContent).toContain("Content");
      await pick("Metadata");
      await pick("Content");
      submit();
      await flush();
      expect(bodies[0]).toEqual({ apps: ["offline", "source"], contentApps: ["offline", "source"] });
      expect(
        [...dom.root.querySelectorAll<HTMLButtonElement>("[role=combobox], button[type=submit]")].every((button) => button.disabled),
      ).toBe(true);
      respond(Response.json({ code: "bad_input", message: "Try again" }, { status: 400 }));
      await flush();
      expect(dom.root.textContent).toContain("Could not change send log access");
      expect(dom.root.querySelectorAll("[role=combobox]")[1]?.textContent).toContain("Content");
      expect(closed).toBe(0);
      await pick("No access");
      submit();
      await flush();
      expect(bodies[1]).toEqual({ apps: ["offline"], contentApps: ["offline"] });
      respond(Response.json(app));
      await flush();
      expect(saved).toBe(1);
      expect(closed).toBe(1);
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click();
      expect(bodies).toHaveLength(2);
      expect(closed).toBe(2);
    } finally {
      dispose();
      fetch.mockRestore();
      restorePopover();
      dom.cleanup();
    }
  });
