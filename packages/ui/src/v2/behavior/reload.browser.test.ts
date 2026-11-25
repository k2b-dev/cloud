// Reload contract for the v2 behaviours (ported from the spike's test/reload.ts). On Solid 1 an @k2b/ssr island
// renders again over its server markup instead of hydrating, so every behaviour must render on the client exactly what
// the server sent: an attribute only the client computes would show as a flash on every reload. Checked per demo, light
// and dark, at 1440 and 390: the client markup equals the server markup (made ids and hydration keys aside), the
// pixels before and after the mount are the same, and layout shift is 0 (Chromium; WebKit has no `layout-shift`
// entries, so there the markup and pixel checks carry the evidence).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../../test/browser";
import { contractCss, demoBundle, serverMarkup } from "../../../test/v2-behavior/harness";

const demos = ["overlays", "select", "board", "transfer", "resize", "controls"] as const;
let browser: Browser;
let css: string;
const bundles = new Map<string, string>();
const markups = new Map<string, string>();
beforeAll(async () => {
  css = await contractCss();
  for (const demo of demos) {
    bundles.set(demo, await demoBundle(demo));
    markups.set(demo, await serverMarkup(demo));
  }
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The markup under #root with hydration keys dropped, made ids replaced, class lists and attributes sorted. */
const normalized = (page: Page, html?: string) =>
  page.evaluate((source) => {
    const root = document.createElement("div");
    if (source === null) root.append(...[...(document.getElementById("root")?.childNodes ?? [])].map((node) => node.cloneNode(true)));
    else root.innerHTML = source;
    const references = new Set(["id", "for", "aria-describedby", "aria-activedescendant"]);
    // Core writes a few attributes only once elements bind, because they depend on the page: `aria-labelledby` on a
    // combobox's chips once its label binds, `aria-controls` on a tab once its panel binds, and a tab stop on a panel
    // without focusable content. None is painted, so none can flash; they are the only attributes left out here.
    const unpainted = new Set(["data-hk", "aria-labelledby", "aria-controls"]);
    const boundTabStop = (node: Element, name: string) => name === "tabindex" && node.getAttribute("role") === "tabpanel";
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof Element)) return "";
      // Core's `bindHold` sets two style properties on the item it binds: `--hold-delay` for CSS and, against iOS's
      // long-press callout, `-webkit-touch-callout`. Neither is painted; both are left out here.
      if (node instanceof HTMLElement) {
        node.style.removeProperty("--hold-delay");
        node.style.removeProperty("-webkit-touch-callout");
      }
      // The server writes an input's value as an attribute, the client as a property; an emptied style is no style.
      const input = node instanceof HTMLInputElement;
      const attrs = [...node.attributes]
        .filter(
          (attr) =>
            !unpainted.has(attr.name) &&
            !boundTabStop(node, attr.name) &&
            !(input && (attr.name === "value" || attr.name === "checked")) &&
            !(attr.name === "style" && !attr.value.trim()),
        )
        .map((attr) => {
          if (references.has(attr.name)) return `${attr.name}=#`;
          // Both styles as the browser parses them: the server writes `width:240px`, the DOM `width: 240px;`.
          if (attr.name === "style" && node instanceof HTMLElement) return `style=${node.style.cssText}`;
          if (attr.name === "class") return `class=${attr.value.split(/\s+/).filter(Boolean).sort().join(" ")}`;
          return `${attr.name}=${attr.value}`;
        })
        .concat(input ? [`value=${node.value}`, `checked=${node.checked}`] : [])
        .sort();
      return `<${node.localName} ${attrs.join(" ")}>${[...node.childNodes].map(walk).join("")}</${node.localName}>`;
    };
    return walk(root);
  }, html ?? null);

for (const demo of demos) {
  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      test(`${demo}, ${theme}, ${width}: the mount changes neither markup nor pixels, layout shift 0`, async () => {
        const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
        page.setDefaultTimeout(2000);
        const errors = pageErrors(page);
        try {
          const markup = markups.get(demo) ?? "";
          await page.setContent(
            `<!doctype html><html lang="de" data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root">${markup}</div></body></html>`,
          );
          await page.addScriptTag({
            content: `window.__shifts = 0; try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__shifts += entry.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}`,
          });
          await settled(page);
          const before = await page.screenshot();
          await page.addScriptTag({ content: bundles.get(demo) ?? "" });
          await page.waitForFunction(() => window.__mounted === true);
          await settled(page);
          const after = await page.screenshot();
          // Compared around the first difference, so a failure names the attribute that changed.
          const [client, server] = [await normalized(page), await normalized(page, markup)];
          let at = 0;
          while (at < client.length && client[at] === server[at]) at++;
          expect(client.slice(Math.max(0, at - 120), at + 120)).toBe(server.slice(Math.max(0, at - 120), at + 120));
          expect(Buffer.compare(before, after)).toBe(0);
          if (browserName === "chromium") expect(await page.evaluate(() => window.__shifts)).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      });
    }
  }
}
