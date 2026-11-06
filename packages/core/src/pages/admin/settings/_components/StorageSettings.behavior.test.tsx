import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { storageEntries } from "./storage-settings.test-fixture";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
(isServer ? test.skip : test)(
  "storage check shows pending, recoverable failure and success, and requires saved settings",
  async () => {
    const dom = createDomTestHarness();
    const { default: Form } = await import("./CoreSettingsForm.island");
    let complete: (response: Response) => void = () => {
      throw new Error("No request pending");
    };
    const requests: string[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (url: unknown) => {
          requests.push(String(url));
          return new Promise<Response>((resolve) => {
            complete = resolve;
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(
      () =>
        createComponent(Form, {
          title: "Storage",
          subtitle: "",
          icon: "ti ti-database",
          entries: storageEntries,
          showTestStorageAction: true,
        }),
      dom.root,
    );
    const button = () =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes("Test connection"))!;
    try {
      expect(dom.root.textContent).toContain("Changes apply without a restart");
      expect(button().disabled).toBe(false);
      button().click();
      await tick();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEndWith("/api/admin/core/settings/test-storage");
      expect(button().getAttribute("aria-busy")).toBe("true");
      expect(button().getAttribute("aria-label")).toContain("Testing connection");
      complete(Response.json({ message: "Storage test failed. Check the saved settings." }, { status: 502 }));
      await tick();
      await tick();
      expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("Storage test failed");
      expect(dom.root.textContent).toContain("Check the saved settings.");
      button().click();
      await tick();
      complete(Response.json({ ok: true }));
      await tick();
      await tick();
      expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("written, read and deleted");
      const input = dom.root.querySelector<HTMLInputElement>('input[placeholder="Garage S3 endpoint"]')!;
      input.value = "https://other.example.test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      expect(button().disabled).toBe(true);
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  },
  20_000,
);
