import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { WorkflowStarter } from "./workflow-starters";

const domTest = isServer ? test.skip : test;
domTest("query export requires a fresh successful preview and hands off a disabled CSV draft", async () => {
  const dom = createDomTestHarness();
  const prototype = dom.window.HTMLElement.prototype;
  const opened = new WeakSet<object>();
  const matches = prototype.matches;
  prototype.matches = function (selector: string) {
    return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
  };
  Object.assign(prototype, {
    showPopover(this: object) {
      opened.add(this);
    },
    hidePopover(this: object) {
      opened.delete(this);
    },
    scrollIntoView() {},
  });
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const bodies: unknown[] = [];
  let reply: PublicDslQueryPreviewResponse = { ok: false, diagnostics: [{ message: "Choose a readable field." }] };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/autocomplete")) return Response.json({ items: [], diagnostics: [] });
      paths.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(reply);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { QueryExportStarter } = await import("./QueryExportStarter");
  const results: WorkflowStarter[] = [];
  let dirty = 0;
  const dispose = render(
    () =>
      createComponent(QueryExportStarter, {
        baseId: "BASE01",
        tables: [],
        fieldsByTable: {},
        onDirty: () => {
          dirty++;
        },
        onComplete: (value) => results.push(value),
      }),
    dom.root,
  );
  const button = (label: string) => {
    const found = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) => element.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  const fillQuery = (query: string) => {
    const input = dom.root.querySelector<HTMLTextAreaElement>("textarea");
    if (!input) throw new Error("Missing query editor");
    input.value = query;
    input.dispatchEvent(Object.assign(new Event("input", { bubbles: true }), { inputType: "insertText" }));
  };
  try {
    expect(button("Choose file format").disabled).toBe(true);
    fillQuery("from table Items\nselect Name as name");
    button("Preview data").click();
    await Bun.sleep(30);
    expect(dom.root.textContent).toContain("Choose a readable field.");
    expect(button("Choose file format").disabled).toBe(true);
    reply = {
      ok: true,
      mode: "rows",
      limit: 100,
      columns: [{ key: "name", label: "Name", type: "text", sqlType: "text" }],
      rows: [{ values: { name: "Camera" } }],
      page: { size: 100, start: 0, returned: 1, nextCursor: "next-page" },
    };
    button("Preview data").click();
    await Bun.sleep(30);
    expect(dom.root.textContent).toContain("Camera");
    expect(button("Choose file format").disabled).toBe(false);
    expect(button("First page").disabled).toBe(true);
    button("Next").click();
    await Bun.sleep(30);
    expect(bodies.at(-1)).toMatchObject({ cursor: "next-page" });
    expect(button("First page").disabled).toBe(false);
    button("First page").click();
    await Bun.sleep(30);
    expect(bodies.at(-1)).not.toHaveProperty("cursor");
    expect(button("First page").disabled).toBe(true);
    fillQuery("from table Items\nselect Name as item");
    expect(button("Choose file format").disabled).toBe(true);
    expect(dom.root.textContent).not.toContain("Camera");
    button("Run inputs").click();
    button("Add input").click();
    const fields = dom.root.querySelectorAll<HTMLInputElement>("input");
    const parameterName = fields[0]!;
    parameterName.focus();
    parameterName.value = "status";
    parameterName.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.document.activeElement).toBe(parameterName);
    const sample = fields[1]!;
    sample.value = "PREVIEW_ONLY";
    sample.dispatchEvent(new Event("input", { bubbles: true }));
    fillQuery("from table Items\nselect Name as item\nwhere Name = @params.status");
    button("Preview data").click();
    await Bun.sleep(30);
    expect(bodies.at(-1)).toMatchObject({ parameters: { status: "PREVIEW_ONLY" } });
    button("Choose file format").click();
    expect(dom.root.textContent).toContain("CSV delimiter");
    expect(dom.root.textContent).not.toContain("Sender IBAN");
    const advanced = button("More output options").closest("section");
    expect(advanced?.getAttribute("data-open")).toBe("false");
    button("More output options").click();
    expect(advanced?.getAttribute("data-open")).toBe("true");
    expect(advanced?.textContent).toContain("Spreadsheet text protection");
    button("Review workflow").click();
    expect(results).toHaveLength(1);
    expect(results[0]?.enabled).toBe(false);
    expect(results[0]?.source).toContain("Name as item");
    expect(results[0]?.source).toContain("kind: csv");
    expect(results[0]?.source).toContain("textProtection: spreadsheet");
    expect(results[0]?.source).toContain("nestedValues: reject");
    expect(results[0]?.source).not.toContain("Camera");
    expect(results[0]?.source).not.toContain("PREVIEW_ONLY");
    expect(results[0]?.source).toContain("${{ inputs.status }}");
    expect(paths.every((path) => path.includes("/gql/by-base/BASE01/execute"))).toBe(true);
    expect(dirty).toBeGreaterThan(0);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
