import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "cloud-search-bar-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { SearchBar } = await import("./index");

const render = async (props: Parameters<typeof SearchBar>[0]) => {
  const html = renderToString(() => createComponent(SearchBar, props));
  const result: {
    html: string;
    fields: [string, string][];
    action: string | null;
    method: string | null;
    clear: string | null;
    label: string | null;
    disabled: boolean;
    scripts: number;
  } = { html, fields: [], action: null, method: null, clear: null, label: null, disabled: false, scripts: 0 };
  await new HTMLRewriter()
    .on("script", {
      element() {
        result.scripts++;
      },
    })
    .on("form", {
      element(e) {
        result.action = e.getAttribute("action");
        result.method = e.getAttribute("method");
      },
    })
    .on("input", {
      element(e) {
        result.fields.push([e.getAttribute("name") ?? "", e.getAttribute("value") ?? ""]);
        if (e.getAttribute("type") === "search") {
          result.label = e.getAttribute("aria-label");
          result.disabled = e.hasAttribute("disabled");
        }
      },
    })
    .on("a", {
      element(e) {
        result.clear = e.getAttribute("href");
      },
    })
    .transform(new Response(html))
    .text();
  return result;
};

describe("SearchBar native HTML contract", () => {
  test("renders a working GET form through the named public export without an island", async () => {
    const result = await render({ action: "/admin/oauth", value: "client", ariaLabel: "Search clients" });
    expect(result.method).toBe("get");
    expect(result.action).toBe("/admin/oauth");
    expect(result.fields).toEqual([["search", "client"]]);
    expect(result.clear).toBe("/admin/oauth");
    expect(result.label).toBe("Search clients");
    expect(result.html).not.toContain("<solid-island");
  });

  test("retains repeated filters and replaces only its own search and page", async () => {
    const result = await render({ action: "/logs?source=core&source=mail&level=error&search=old&page=8", value: "new" });
    expect(result.fields).toEqual([
      ["source", "core"],
      ["source", "mail"],
      ["level", "error"],
      ["search", "new"],
    ]);
    expect(result.clear).toBe("/logs?source=core&amp;source=mail&amp;level=error");
  });

  test("keeps independent searches and their pagination", async () => {
    const result = await render({
      action: "/admin/mail/security?reports=spam&reports-page=7&rules=deny&rules-page=3&identities=alice",
      param: "reports",
      pageParam: "reports-page",
    });
    expect(result.fields).toEqual([
      ["rules", "deny"],
      ["rules-page", "3"],
      ["identities", "alice"],
      ["reports", "spam"],
    ]);
    expect(result.clear).toBe("/admin/mail/security?rules=deny&amp;rules-page=3&amp;identities=alice");
  });

  test("uses action search as initial value and resets a cursor", async () => {
    const result = await render({ action: "/admin/mail?q=hello&cursor=next", param: "q", pageParam: "cursor" });
    expect(result.fields).toEqual([["q", "hello"]]);
    expect(result.clear).toBe("/admin/mail");
  });

  test("keeps relative and absolute destinations and fragments", async () => {
    for (const path of ["./items", "/items", "https://cloud.example/items"]) {
      const result = await render({ action: `${path}?scope=all&page=2#results?detail` });
      expect(result.action).toBe(`${path}#results?detail`);
      expect(result.clear).toBe(`${path}?scope=all#results?detail`);
      expect(result.fields).toEqual([
        ["scope", "all"],
        ["search", ""],
      ]);
    }
  });

  test("clearing a query-only action explicitly replaces the current query", async () => {
    for (const action of ["?search=old&page=2", "?search=old&page=2#results"]) {
      const result = await render({ action });
      expect(result.clear).toBe(action.includes("#") ? "?#results" : "?");
      expect(result.fields).toEqual([["search", "old"]]);
    }
  });

  test("round-trips encoded filters and safely escapes input markup", async () => {
    const result = await render({ action: "/items?tag=a%26b&search=%3Cscript%3E%22" });
    expect(result.scripts).toBe(0);
    expect(result.fields).toEqual([
      ["tag", "a&amp;b"],
      ["search", "<script>&quot;"],
    ]);
    expect(result.clear).toBe("/items?tag=a%26b");
  });

  test("disabled search also removes the navigation affordance", async () => {
    const result = await render({ action: "/items?search=old", disabled: true });
    expect(result.disabled).toBe(true);
    expect(result.clear).toBeNull();
  });
});
