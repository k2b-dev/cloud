import { test, expect, mock } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { blankStarter } from "../src/starter";
import { validateProject } from "../src/project";
(isServer ? test.skip : test)("SQL console keeps focus, runs explicitly and ignores cancelled results", async () => {
  const dom = createDomTestHarness();
  let calls = 0,
    finish: ((v: unknown) => void) | undefined;
  const state = {
    enabled: true,
    globallyEnabled: true,
    provisioned: true,
    generation: 1,
    status: "ready",
    canAdmin: true,
    error: null,
    overview: null,
    tables: [{ name: "todos", type: "table", row_count: 2 }],
  };
  const saved = {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Count",
    sql: "SELECT 1",
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
  let fail = false;
  mock.module("../src/frontend/client", () => ({
    client: {
      projects: {
        ":id": {
          database: {
            $get: async () => state,
            call: {
              $post: async (input: { json: { request: { operation: string } } }) => {
                if (input.json.request.operation === "schema.get") return { columns: [{ name: "title", type: "TEXT" }] };
                if (fail) throw new Error("query error");
                calls++;
                return new Promise((resolve) => {
                  finish = resolve;
                });
              },
            },
          },
          queries: { $get: async () => ({ items: [saved], page: 1, hasNext: false }), ":queryId": { $get: async () => saved } },
        },
      },
    },
    checked: async (value: unknown) => value,
    displayError: () => "Request failed",
    KitRequestError: class extends Error {
      code = "";
    },
  }));
  const { default: Console } = await import("../src/frontend/QueryConsole.island");
  const dispose = render(
    () =>
      createComponent(Console, {
        project: {
          ...blankStarter,
          id: "abc123",
          revision: 1,
          sdkVersion: 1,
          updatedAt: new Date().toISOString(),
          permission: "write",
          entries: validateProject(blankStarter).entries,
        },
        state,
        initial: saved,
        queries: [saved],
        hasNext: false,
      }),
    dom.root,
  );
  const tick = async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };
  const button = (label: string) => Array.from(dom.root.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
  try {
    await tick();
    expect(calls).toBe(0);
    expect(button("Save")).toBeUndefined();
    expect(dom.root.textContent).not.toContain("SELECT only");
    expect(button("Save as")).toBeUndefined();
    button("Info").click();
    await tick();
    expect(dom.root.querySelector(".kit-sql-results")?.textContent).toContain("title");
    expect(dom.root.querySelector(".kit-sql-results")?.textContent).toContain("TEXT");
    expect(dom.root.querySelectorAll(".kit-sql-schema h2").length).toBe(1);
    expect(dom.root.querySelector(".kit-sql-schema h2")?.textContent).toContain("todos");
    expect(dom.root.querySelector(".kit-sql-schema dl dt")?.textContent).toBe("title");
    expect(dom.root.querySelector(".kit-sql-results")?.classList.contains("k2b-paper")).toBe(false);
    button("Results").click();
    const input = dom.root.querySelector("textarea")!;
    input.focus();
    for (const c of " AS value") {
      input.value += c;
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      await tick();
      expect(dom.root.querySelector("textarea")).toBe(input);
      expect(dom.document.activeElement).toBe(input);
    }
    button("Run").click();
    await tick();
    expect(calls).toBe(1);
    button("Cancel").click();
    finish!({ data: [{ value: "old result" }] });
    await tick();
    expect(dom.root.textContent).not.toContain("old result");
    button("Run").click();
    await tick();
    finish!({ data: [{ value: "new result" }] });
    await tick();
    expect(dom.root.textContent).toContain("new result");
    expect(dom.root.querySelectorAll(".kit-sql-results .k2b-status-badge").length).toBe(2);
    input.value = "SELECT 2";
    input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await tick();
    expect(dom.root.textContent).toContain("The editor has changed");
    fail = true;
    button("Run").click();
    await tick();
    expect(dom.root.querySelector(".kit-sql-results [role=alert]")?.textContent).toBe("Request failed");
    expect(dom.root.querySelectorAll("[role=alert]").length).toBe(1);
    fail = false;
    button("todos · 2").click();
    await tick();
    finish!({ data: [{ title: "Task" }] });
    await tick();
    expect(dom.root.querySelector('.kit-sql-main [role=radiogroup]')?.getAttribute("aria-label")).toBe("Table view");
    expect(dom.root.querySelector('.kit-sql-results [role=radiogroup]')).toBeNull();
    expect(dom.root.querySelector('.kit-sql-results .k2b-table-shell')?.getAttribute("data-surface")).toBe("paper");
    expect(dom.root.textContent).not.toContain("Page 1");
    button("Structure").click();
    await tick();
    expect(dom.root.querySelector(".kit-sql-drawer")?.hasAttribute("hidden")).toBe(true);
    expect(dom.root.querySelector(".kit-sql-main .k2b-table-shell")?.getAttribute("data-surface")).toBe("paper");
  } finally {
    dispose();
    mock.restore();
    dom.cleanup();
  }
});
