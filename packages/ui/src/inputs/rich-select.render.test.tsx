import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Window } from "happy-dom";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../styles/css-contract-test-helpers";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-rich-select-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { RichSelect, RichSelectFacts, RICH_SELECT_SEARCH_FROM } = await import("./RichSelect");

function inspect(html: string, check: (document: Document) => void) {
  const window = new Window();
  try {
    window.document.body.innerHTML = html;
    check(window.document as unknown as Document);
  } finally {
    window.close();
  }
}

describe("RichSelect server contract", () => {
  test("renders the trigger, row anatomy and unavailable reason with accessible associations", () => {
    const html = renderToString(() =>
      createComponent(RichSelect, {
        label: "Move card",
        title: "Targets",
        value: "review",
        name: "target",
        items: [
          { value: "review", label: "Review", description: "Two tags are dropped", color: "#8b5cf6" },
          { value: "archive", label: "Archive", description: "Nothing is dropped", icon: "ti ti-archive" },
          { value: "support", label: "Support", description: "This must disappear", disabledReason: "No write access" },
          { value: "custom", label: "Custom", visual: "Custom visual", color: "#000", icon: "ti ti-star" },
        ],
      }),
    );
    inspect(html, (document) => {
      const trigger = document.querySelector('[role="combobox"]')!;
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[popover="manual"]')).not.toBeNull();
      expect(document.querySelector('input[name="target"]')?.getAttribute("value")).toBe("review");
      expect(document.querySelector(".k2b-rich-select__title")?.textContent).toBe("Targets");
      const rows = [...document.querySelectorAll('[role="option"]')];
      expect(rows).toHaveLength(4);
      expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
      expect(rows[0]!.querySelector(".k2b-rich-select__label")?.textContent).toBe("Review");
      expect(rows[0]!.querySelectorAll(".k2b-rich-select__line")).toHaveLength(1);
      expect(rows[0]!.querySelector(".k2b-rich-select__line")?.textContent).toBe("Two tags are dropped");
      expect(rows[0]!.querySelector(".k2b-rich-select__dot")?.getAttribute("style")).toContain("#8b5cf6");
      expect(rows[1]!.querySelector(".k2b-rich-select__visual i")?.className).toBe("ti ti-archive");
      const unavailable = rows[2]!;
      expect(unavailable.getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(unavailable.getAttribute("aria-labelledby")!)?.textContent).toBe("Support");
      expect(document.getElementById(unavailable.getAttribute("aria-describedby")!)?.textContent).toBe("No write access");
      expect(unavailable.textContent).not.toContain("This must disappear");
      expect(unavailable.querySelectorAll(".k2b-rich-select__line")).toHaveLength(1);
      expect(rows[3]!.querySelector(".k2b-rich-select__visual")?.textContent).toBe("Custom visual");
      expect(rows[3]!.querySelector(".k2b-rich-select__dot, i.ti-star")).toBeNull();
    });
  });

  test.each([7, 8])("search and section headings follow the eight-option threshold (%i items)", (count) => {
    const html = renderToString(() =>
      createComponent(RichSelect, {
        value: null,
        label: "Destination",
        items: Array.from({ length: count }, (_, index) => ({
          value: `${index}`,
          label: `Target ${index}`,
          section: index < 4 ? "one" : "two",
        })),
        sections: [
          { id: "one", label: "First section" },
          { id: "two", label: "Second section" },
        ],
      }),
    );
    expect(RICH_SELECT_SEARCH_FROM).toBe(8);
    inspect(html, (document) => {
      expect(document.querySelectorAll('input[type="search"]')).toHaveLength(count >= 8 ? 1 : 0);
      expect([...document.querySelectorAll(".k2b-rich-select__heading")].map((node) => node.textContent)).toEqual(
        count >= 8 ? ["First section", "Second section"] : [],
      );
    });
  });

  test("facts stop at three and preserve warning tone", () => {
    const html = renderToString(() =>
      createComponent(RichSelectFacts, {
        facts: [
          { icon: "ti ti-users", text: "Visible to 8 members" },
          { icon: "ti ti-tag-off", text: "Two tags are dropped", tone: "warning" },
          { icon: "ti ti-paperclip", text: "Attachments move along" },
          { icon: "ti ti-x", text: "Do not render this fourth fact" },
        ],
      }),
    );
    inspect(html, (document) => {
      expect(document.querySelectorAll("ul.k2b-rich-select__facts > li")).toHaveLength(3);
      expect(document.querySelector('li[data-tone="warning"]')?.textContent).toBe("Two tags are dropped");
      expect(document.querySelector('li i[aria-hidden="true"]')?.className).toBe("ti ti-users");
    });
    expect(html).not.toContain("Do not render");
  });

  test("loading exposes four placeholder rows, a busy list and a preview placeholder", () => {
    const html = renderToString(() =>
      createComponent(RichSelect, {
        label: "Destination",
        value: null,
        items: [],
        status: "loading",
        renderPreview: () => "Preview",
      }),
    );
    inspect(html, (document) => {
      expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
      expect(document.querySelectorAll(".k2b-rich-select__placeholder")).toHaveLength(4);
      expect(document.querySelector(".k2b-rich-select__preview-placeholder")).not.toBeNull();
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    });
  });

  test("shipped label, line, preview title and facts CSS wraps without truncation", () => {
    const rules = readShippedCssRules(resolve(import.meta.dir, "../styles"));
    for (const selector of [
      ".k2b-rich-select__label",
      ".k2b-rich-select__line",
      ".k2b-rich-select__preview-title",
      ".k2b-rich-select__facts > li",
    ]) {
      const applicable = rules.filter((rule) => rule.selector.endsWith(selector));
      expect(applicable.length).toBeGreaterThan(0);
      expect(applicable.some((rule) => cssDeclarations(rule.body).get("overflow-wrap")?.includes("anywhere"))).toBe(true);
      for (const rule of applicable) {
        const declarations = cssDeclarations(rule.body);
        expect(declarations.get("text-overflow") ?? []).not.toContain("ellipsis");
        expect(declarations.get("white-space") ?? []).not.toContain("nowrap");
        expect(declarations.has("line-clamp")).toBe(false);
        expect(declarations.has("-webkit-line-clamp")).toBe(false);
        expect(declarations.get("overflow") ?? []).not.toContain("hidden");
      }
    }
  });
});
