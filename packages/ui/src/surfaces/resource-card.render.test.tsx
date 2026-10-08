import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../styles/css-contract-test-helpers";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-resource-card-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider, ResourceCard } = await import("../index");
type Props = Parameters<typeof ResourceCard>[0];

/** Everything the caller knows about the element, so each state shows what it leaves out. */
const element: Props = {
  title: "Onboarding checklist",
  icon: "ti ti-notebook",
  source: "Notebooks",
  location: "Team handbook",
  preview: "Laptop, accounts, and the first week",
  href: "/notebooks/onboarding",
};
const card = (props: Partial<Props> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ResourceCard, { ...element, ...props });
      },
    }),
  );
/** The text a reader meets; comments such as hydration markers drop out. */
const textOf = (html: string) => {
  let text = "";
  new HTMLRewriter()
    .on("*", {
      element(element) {
        text += " ";
        if (!element.canHaveContent) return;
        element.onEndTag(() => {
          text += " ";
        });
      },
    })
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(html);
  return text.replace(/\s+/g, " ").trim();
};

const hidden = [element.title, element.source, element.location, element.preview, element.href, element.icon] as string[];
const reasons = [
  { state: "no-access", icon: "ti ti-lock", en: "No access", de: "Kein Zugriff" },
  { state: "deleted", icon: "ti ti-trash", en: "Item deleted", de: "Element gelöscht" },
  { state: "unavailable", icon: "ti ti-cloud-off", en: "Not available right now", de: "Gerade nicht verfügbar" },
] as const;

describe("ResourceCard", () => {
  test("shows the element with its icon, source and location, and preview as one link", () => {
    const html = card();

    expect(html).toMatch(/^<a class="k2b-resource-card" data-state="ok" href="\/notebooks\/onboarding">/);
    expect(html).toContain('<i class="ti ti-notebook">');
    expect(textOf(html)).toBe("Onboarding checklist Notebooks · Team handbook Laptop, accounts, and the first week");
    expect(html).not.toContain("aria-busy");
  });

  test("leaves out empty lines and uses a generic icon without one", () => {
    const html = card({ icon: undefined, source: undefined, location: " ", preview: "" });

    expect(html).toContain('<i class="ti ti-file">');
    expect(textOf(html)).toBe("Onboarding checklist");
    expect(html).not.toContain("k2b-resource-card__meta");
    expect(html).not.toContain("k2b-resource-card__preview");
  });

  test("opens in place with a button when the caller handles it, and is no control without a target", () => {
    expect(card({ onOpen: () => {} })).toMatch(/^<button type="button" class="k2b-resource-card" data-state="ok">/);
    expect(card({ href: undefined })).toMatch(/^<div class="k2b-resource-card" data-state="ok">/);
  });

  test("never links to a scheme that runs code", () => {
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      const html = card({ href });
      expect(html).toMatch(/^<div /);
      expect(html).not.toContain("href=");
    }
    expect(card({ href: "https://example.com/doc" })).toContain('href="https://example.com/doc"');
  });

  for (const reason of reasons) {
    test(`shows only "${reason.en}" in English and "${reason.de}" in German for ${reason.state}`, () => {
      for (const locale of ["en", "de"] as const) {
        const html = card({ state: reason.state, onOpen: () => {} }, locale);

        expect(html).toMatch(new RegExp(`^<div class="k2b-resource-card" data-state="${reason.state}">`));
        expect(html).toContain(`<i class="${reason.icon}">`);
        expect(textOf(html)).toBe(reason[locale]);
        // Nothing of the element reaches the reader or the markup, and nothing opens it.
        for (const value of hidden) expect(html).not.toContain(value);
        expect(html).not.toContain("<button");
        expect(html).not.toContain("<a ");
      }
    });
  }

  test("tells screen readers it is loading in English and German, without the element", () => {
    for (const [locale, text] of [
      ["en", "Loading..."],
      ["de", "Wird geladen..."],
    ] as const) {
      const html = card({ state: "loading" }, locale);

      expect(html).toMatch(/^<div class="k2b-resource-card" data-state="loading" aria-busy="true">/);
      expect(html.match(/k2b-resource-card__bar/g)).toHaveLength(2);
      expect(textOf(html)).toBe(text);
      expect(html).toContain('<span class="k2b-sr-only">');
      for (const value of hidden) expect(html).not.toContain(value);
    }
  });

  test("keeps the caller's class in every state", () => {
    for (const state of ["ok", "loading", "no-access", "deleted", "unavailable"] as const)
      expect(card({ state, class: "shared-card" })).toContain('class="k2b-resource-card shared-card"');
  });
});

describe("ResourceCard styles", () => {
  const rules = readShippedCssRules(resolve(import.meta.dir, "../styles")).filter((rule) => rule.selector.includes("k2b-resource-card"));
  const sizing = [
    "width",
    "height",
    "min-height",
    "max-height",
    "padding",
    "padding-block",
    "border-width",
    "grid-template-columns",
    "font-size",
  ];

  test("sizes the card once, for every state and theme", () => {
    const base = cssDeclarations(rules.find((rule) => rule.selector === ".k2b-ui .k2b-resource-card" && !rule.context)?.body ?? "");
    expect(base.get("width")).toEqual(["22rem"]);
    expect(base.get("max-width")).toEqual(["100%"]);
    expect(base.get("height")).toEqual(["4.625rem"]);
    expect(base.get("overflow")).toEqual(["hidden"]);

    // No state, hover, focus, or theme rule changes the card's box.
    const resizing = rules
      .filter((rule) => rule.selector !== ".k2b-ui .k2b-resource-card" && /\.k2b-resource-card(?:\[|:|\s*$|,)/.test(rule.selector))
      .filter((rule) => sizing.some((property) => cssDeclarations(rule.body).has(property)))
      .map((rule) => rule.selector);
    expect(resizing).toEqual([]);
  });

  test("paints only with theme tokens, so the dark theme needs no rules of its own", () => {
    expect(rules.filter((rule) => /dark/.test(rule.selector)).map((rule) => rule.selector)).toEqual([]);
    const literals = rules
      .filter((rule) => !rule.context?.includes("forced-colors"))
      .flatMap((rule) => ["color", "background", "background-color"].flatMap((property) => cssDeclarations(rule.body).get(property) ?? []))
      .filter((value) => !/^var\(--k2b-[\w-]+\)$/.test(value));
    expect(literals).toEqual([]);
  });
});
