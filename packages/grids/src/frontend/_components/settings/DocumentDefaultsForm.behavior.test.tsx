import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("saving structured issuer details keeps untouched freeform address text verbatim", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Promise<Response>(() => {});
    },
    { preconnect: originalFetch.preconnect },
  );
  const { SettingsModal } = await import("@k2b/ui");
  const { DocumentDefaultsForm } = await import("./BaseSettingsSections");
  const address = "  Old Street 1\n89073 Ulm  \n";
  const dispose = render(
    () =>
      createComponent(SettingsModal, {
        title: "Base settings",
        defaultTab: "documents",
        get children() {
          return createComponent(SettingsModal.Tab, {
            id: "documents",
            title: "Documents",
            get children() {
              return createComponent(DocumentDefaultsForm, {
                base: { id: "BASE01", documentDefaults: { legalName: "Example GmbH", address } },
                onDirtyChange: () => {},
                onSavingChange: () => {},
              });
            },
          });
        },
      }),
    dom.root,
  );
  const input = (label: string) => {
    const node = Array.from(dom.root.querySelectorAll("label")).find((node) => node.textContent?.trim() === label)!;
    const control = dom.document.querySelector<HTMLInputElement>(`input[id="${node.htmlFor}"]`);
    if (!control) throw new Error(`Missing input: ${label}`);
    return control;
  };
  try {
    for (const [label, value] of [
      ["Postal code", "89073"],
      ["City", "Ulm"],
      ["Country code", "de"],
      ["VAT ID", "DE123456789"],
      ["Account holder", "Example GmbH"],
    ]) {
      const control = input(label!);
      control.value = value!;
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }
    Array.from(dom.root.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Save changes")!
      .click();
    await Bun.sleep(5);
    expect(body).toEqual({
      documentDefaults: {
        legalName: "Example GmbH",
        address,
        postalCode: "89073",
        city: "Ulm",
        countryCode: "DE",
        vatId: "DE123456789",
        accountName: "Example GmbH",
      },
    });
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
