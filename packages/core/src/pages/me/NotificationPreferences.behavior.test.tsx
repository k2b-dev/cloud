import { expect, spyOn, test } from "bun:test";
import type { UserNotificationPreference } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), NotificationPreferences: (await import("./NotificationPreferences.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("excluded rows stay unchecked through reset, pending saves, and failed saves", async () => {
    const dom = createDomTestHarness();
    const { ui, NotificationPreferences } = modules!;
    const reason = "Nicht verfügbar: Jede Nachricht als E-Mail wäre zu viel.";
    const preference: UserNotificationPreference = {
      id: "demo.update",
      appId: "demo",
      kind: "update",
      label: "Meldungen",
      description: "Neue Meldungen.",
      recommendedChannels: ["browser", "email"],
      requiredChannels: [],
      excludedChannels: ["email"],
      excludedReason: reason,
      selectedChannels: ["email"],
      effectiveChannels: [],
      customized: true,
    };
    const calls: string[] = [];
    let resolve: ((response: Response) => void) | undefined;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost/"), init);
          calls.push(request.method);
          return new Promise<Response>((answer) => {
            resolve = answer;
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    delegateEvents(["click", "change"]);
    const dispose = render(
      () =>
        createComponent(ui.LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(NotificationPreferences, {
              initial: { availableChannels: ["browser", "email"], definitions: [preference] },
              apps: [{ id: "demo", name: "Demo", icon: "ti ti-bell" }],
            });
          },
        }),
      dom.root,
    );
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise<void>((done) => queueMicrotask(done));
    };
    const checkbox = (label: string) =>
      [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
        input.closest("label")?.textContent?.includes(label),
      )!;
    try {
      const email = checkbox("E-Mail");
      const browser = checkbox("Browser");
      expect(email.disabled).toBe(true);
      expect(email.checked).toBe(false);
      expect(dom.document.getElementById(email.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
      email.click();
      expect(calls).toEqual([]);
      const reset = [...dom.document.querySelectorAll("button")].find((button) => button.textContent?.includes("App-Vorgabe verwenden"))!;
      reset.click();
      await settle();
      expect(calls).toEqual(["DELETE"]);
      expect(browser.checked).toBe(true);
      expect(browser.disabled).toBe(true);
      expect(email.checked).toBe(false);
      resolve!(Response.json({ ...preference, selectedChannels: ["browser"], effectiveChannels: ["browser"], customized: false }));
      await settle();
      expect(browser.disabled).toBe(false);
      expect(email.disabled).toBe(true);
      expect(email.checked).toBe(false);
      browser.click();
      await settle();
      expect(calls).toEqual(["DELETE", "PUT"]);
      resolve!(Response.json({ error: "Unavailable" }, { status: 503 }));
      await settle();
      expect(browser.checked).toBe(true);
      expect(browser.disabled).toBe(false);
      expect(email.checked).toBe(false);
      expect(email.disabled).toBe(true);
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
}
