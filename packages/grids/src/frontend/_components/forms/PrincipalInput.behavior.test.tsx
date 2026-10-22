import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PrincipalReference } from "../../../field-types/principal";

const domTest = isServer ? test.skip : test;
const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Principal input did not reach the expected state");
};

for (const kind of ["standalone", "agent"] as const) {
  domTest(`${kind}: searches, selects and hydrates a named machine principal`, async () => {
    const dom = createDomTestHarness();
    const prototype = dom.window.HTMLElement.prototype;
    Object.assign(prototype, { showPopover() {}, hidePopover() {}, scrollIntoView() {} });
    const originalFetch = globalThis.fetch;
    const urls: URL[] = [];
    const id = "00000000-0000-4000-8000-000000000123";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        urls.push(new URL(input instanceof Request ? input.url : String(input)));
        return Response.json({ items: [{ kind: "service_account", serviceAccount: { id, name: "Catalog assistant", kind } }] });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: PrincipalInput } = await import("./PrincipalInput");
    delegateEvents(["input", "click"]);
    const selected: PrincipalReference[][] = [];
    const dispose = render(() => {
      const [value, setValue] = createSignal<PrincipalReference[] | null>(null);
      return (
        <PrincipalInput
          label="Participants"
          value={value()}
          multi
          onChange={(next) => {
            if (next) selected.push(next);
            setValue(next);
          }}
        />
      );
    }, dom.root);
    try {
      dom.root.querySelector<HTMLButtonElement>(".k2b-multi-select-trigger")!.click();
      const search = dom.document.querySelector<HTMLInputElement>(
        'input[type="search"], input[role="combobox"], input[placeholder*="Search"]',
      )!;
      expect(search).not.toBeNull();
      search.value = "Catalog";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => !!dom.document.querySelector('[role="option"]'));
      expect(urls.some((url) => url.searchParams.get("kinds") === "user,group,service_account")).toBe(true);
      const option = dom.document.querySelector<HTMLElement>('[role="option"]')!;
      expect(option.textContent).toContain("Catalog assistant");
      expect(option.querySelector(kind === "agent" ? ".ti-robot" : ".ti-key")).not.toBeNull();
      option.click();
      await waitFor(() => selected.length > 0);
      expect(selected).toEqual([[{ type: "service_account", id }]]);
      expect(dom.root.textContent).toContain("Catalog assistant");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  domTest(`${kind}: reload resolves only the selected service-account ID`, async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const urls: URL[] = [];
    const id = "00000000-0000-4000-8000-000000000123";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        urls.push(new URL(input instanceof Request ? input.url : String(input)));
        return Response.json({ items: [{ kind: "service_account", serviceAccount: { id, name: "Catalog assistant", kind } }] });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: PrincipalInput } = await import("./PrincipalInput");
    const dispose = render(
      () => <PrincipalInput label="Participants" value={[{ type: "service_account", id }]} multi onChange={() => {}} />,
      dom.root,
    );
    try {
      await waitFor(() => !!dom.root.textContent?.includes("Catalog assistant"));
      expect(urls).toHaveLength(1);
      expect(urls[0]!.searchParams.get("kinds")).toBe("service_account");
      expect(urls[0]!.searchParams.get("service_account_ids")).toBe(id);
      expect(dom.root.textContent).not.toContain(id);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
