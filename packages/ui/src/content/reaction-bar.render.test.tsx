import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../styles/css-contract-test-helpers";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-reaction-bar-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider, ReactionBar, reactionPeople } = await import("../index");
type Props = Parameters<typeof ReactionBar>[0];
const reactions = ["👍", "☕", "🎉", "❤️", "👀"].map((emoji, index) => ({
  key: emoji,
  emoji,
  count: index + 1,
  own: index === 0,
  label: reactionPeople({ names: ["Nora"], count: index + 1 }),
  busy: index === 0,
}));
const bar = (props: Partial<Props> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ReactionBar, { reactions, ...props });
      },
    }),
  );
const elements = (html: string, selector: string) => {
  const found: Record<string, string>[] = [];
  new HTMLRewriter()
    .on(selector, {
      element(element) {
        found.push(Object.fromEntries(element.attributes));
      },
    })
    .transform(html);
  return found;
};

describe("ReactionBar", () => {
  for (const [locale, label] of [
    ["en", "2 more reactions"],
    ["de", "2 weitere Reaktionen"],
  ]) {
    test(`limits emoji and presents the rest as pointer-transparent text (${locale})`, () => {
      const html = bar({ max: 3 }, locale);
      expect(elements(html, ".k2b-reaction-bar__chip")).toHaveLength(3);
      expect(elements(html, ".k2b-reaction-bar__more")).toEqual([{ class: "k2b-reaction-bar__more" }]);
      expect(html).toContain('+2</span><span class="k2b-sr-only">' + label + "</span>");
      expect(elements(html, ".k2b-reaction-bar__more button, .k2b-reaction-bar__more [tabindex]")).toHaveLength(0);
      expect(html).not.toContain("k2b-reaction-bar__scroll");
      expect(html).toContain('data-overflow="wrap"');
      expect(bar({ max: 3, moreLabel: (n) => `${n} further emoji` }, locale)).toContain("2 further emoji");
    });
  }
  test("renders writable chips with pressed and pending state, and one names hint without native titles", () => {
    const html = bar({ onToggle: () => {}, onAdd: () => {} });
    const chips = elements(html, "button.k2b-reaction-bar__chip");
    expect(chips).toHaveLength(5);
    expect(chips[0]).toMatchObject({
      type: "button",
      "aria-pressed": "true",
      "aria-busy": "true",
      "data-own": "",
      "data-reaction-key": "👍",
      "aria-label": "👍 1 reaction: Nora",
    });
    expect(chips[1]).toMatchObject({ "aria-pressed": "false" });
    expect(chips[1]).not.toHaveProperty("aria-busy");
    // The names hint replaces a native title on the chips; "Add reaction" keeps its usual tooltip.
    for (const chip of chips) expect(chip).not.toHaveProperty("title");
    expect(elements(html, ".k2b-reaction-bar__hint")).toEqual([
      { class: "k2b-tooltip k2b-reaction-bar__hint", popover: "manual", role: "tooltip", "aria-hidden": "true" },
    ]);
    expect(elements(html, ".k2b-reaction-bar__add-button")[0]).toMatchObject({ "aria-label": "Add reaction", "aria-haspopup": "dialog" });
  });
  test("read-only chips are images ignored by GestureMenu, with one scrolling tab stop", () => {
    const html = bar();
    const chips = elements(html, "span.k2b-reaction-bar__chip");
    expect(chips).toHaveLength(5);
    for (const chip of chips) {
      expect(chip).toMatchObject({ role: "img", "data-gesture-ignore": "" });
      expect(chip).not.toHaveProperty("tabindex");
      expect(chip).not.toHaveProperty("aria-pressed");
    }
    expect(chips[0]).toMatchObject({ "aria-busy": "true", "aria-label": "👍 your reaction: Nora" });
    expect(elements(html, "button")).toHaveLength(0);
    expect(elements(html, ".k2b-reaction-bar__scroll")[0]).toMatchObject({ tabindex: "0" });
    expect(elements(bar({ overflow: "wrap" }), "[tabindex]")).toHaveLength(0);
  });
  test("exposes density, layout and progressive add without adding a scroll area to empty bars", () => {
    const html = bar({ density: "compact", overflow: "wrap", add: "progressive", onAdd: () => {}, class: "caller" });
    expect(elements(html, ".k2b-reaction-bar")[0]).toMatchObject({
      class: "k2b-reaction-bar caller",
      role: "group",
      "aria-label": "Reactions",
      "data-density": "compact",
      "data-overflow": "wrap",
      "data-add": "progressive",
    });
    expect(elements(html, ".k2b-reaction-bar__add")[0]?.class).toBe("k2b-reaction-bar__add k2b-progressive-action");
    expect(bar({ reactions: [] })).toContain('data-empty=""');
    expect(bar({ reactions: [] })).not.toContain("k2b-reaction-bar__scroll");
    expect(bar()).not.toContain("data-add");
    expect(bar()).toContain('data-density="default" data-overflow="scroll"');
  });
  test("keeps chip sizes, outside focus and non-interactive +n in the shipped CSS", () => {
    const rules = readShippedCssRules(resolve(import.meta.dir, "../styles"));
    const declarations = (selector: string) =>
      cssDeclarations(rules.find((rule) => rule.selector === selector && !rule.context)?.body ?? "");
    expect(declarations(".k2b-ui .k2b-reaction-bar").get("--k2b-reaction-height")).toEqual(["1.625rem"]);
    expect(declarations('.k2b-ui .k2b-reaction-bar[data-density="compact"]').get("--k2b-reaction-height")).toEqual(["1.5rem"]);
    expect(declarations(".k2b-ui .k2b-reaction-bar__chip").get("height")).toEqual(["var(--k2b-reaction-height)"]);
    expect(declarations(".k2b-ui .k2b-reaction-bar__more").get("pointer-events")).toEqual(["none"]);
    expect(declarations(".k2b-ui .k2b-reaction-bar__chip:focus-visible").get("outline-offset")).toEqual(["calc(var(--k2b-focus-width) / 2)"]);
  });
});
