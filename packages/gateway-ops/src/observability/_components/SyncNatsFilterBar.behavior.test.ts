import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const browserTest = isServer ? test.skip : test;
browserTest("filter bar uses search and selectable chips instead of labelled form fields", async () => {
  const dom = createDomTestHarness();
  const { default: FilterBar } = await import("./SyncNatsFilterBar.island");
  const dispose = render(
    () =>
      createComponent(FilterBar, {
        path: "/admin/observability/nats",
        search: "?app=mail&namespace=dev&problems=true",
        apps: ["mail", "core"],
        namespaces: ["dev"],
      }),
    dom.root,
  );
  try {
    expect(dom.root.querySelector('[role="search"]')).not.toBeNull();
    expect(dom.root.querySelector('input[name="resource"]')).not.toBeNull();
    // App and namespace are chips; the search form only carries them along as hidden fields.
    expect(dom.root.querySelector('input[name="app"]:not([type="hidden"])')).toBeNull();
    expect(dom.root.querySelector<HTMLInputElement>('input[type="hidden"][name="app"]')?.value).toBe("mail");
    const chips = dom.root.querySelectorAll(".k2b-filter-chip");
    expect(chips.length).toBe(3);
    expect(dom.root.textContent).toContain("mail");
    expect(dom.root.textContent).toContain("dev");
    expect(dom.root.querySelector('a[href="/admin/observability/nats"]')).not.toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
