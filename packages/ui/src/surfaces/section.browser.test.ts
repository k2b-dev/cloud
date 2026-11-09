import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// Which rule wins and how large a hit area is are cascade and layout questions, so a real engine renders them.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-section-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Section } = await import("./Section");
const { Button } = await import("../actions/Button");
const { LocaleProvider } = await import("../intl/locale");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const markup = renderToString(() => [
  createComponent(Section, {
    id: "page",
    size: "md",
    icon: "ti ti-alert-circle",
    title: "Payment",
    tone: "danger",
    meta: "Failed",
    children: "…",
  }),
  createComponent(Section, { id: "panel", icon: "ti ti-alert-circle", title: "Payment", tone: "danger", meta: "Failed", children: "…" }),
  createComponent(Section, {
    id: "flat",
    frame: "none",
    icon: "ti ti-palette",
    title: "Appearance",
    collapsible: true,
    children: "Fields",
  }),
]);

describe("Section in a real engine", () => {
  test("a tone colors the title of a page section and of a panel section alike", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    try {
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">${markup}</body></html>`);
      await settled(page);
      const colors = await page.evaluate(() => {
        const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = "var(--k2b-danger-text)";
        const danger = getComputedStyle(probe).color;
        probe.remove();
        return { danger, page: color("#page .k2b-section__title"), panel: color("#panel .k2b-section__title") };
      });
      expect(colors.page).toBe(colors.danger);
      expect(colors.panel).toBe(colors.danger);
    } finally {
      await page.close();
    }
  });

  test("a page section is an island with the raised shadow, and the same section in a flat layer casts none", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">${markup}` +
          `<div id="flat-layer" data-k2b-layer="flat">${markup.replaceAll('id="', 'id="flat-')}</div></body></html>`,
      );
      await settled(page);
      const shadows = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.boxShadow = "var(--k2b-shadow-raised)";
        const raised = getComputedStyle(probe).boxShadow;
        probe.remove();
        const shadow = (selector: string) => getComputedStyle(document.querySelector(selector)!).boxShadow;
        return { raised, page: shadow("#page"), flat: shadow("#flat-page") };
      });
      expect(shadows.raised).not.toBe("none");
      expect(shadows.page).toBe(shadows.raised);
      expect(shadows.flat).not.toBe(shadows.raised);
      expect(shadows.flat).toMatch(/^(none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)$/);
    } finally {
      await page.close();
    }
  });

  test("a flat disclosure row keeps a 44 px hit area on touch without growing", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
    try {
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">${markup}</body></html>`);
      await settled(page);
      const sizes = await page.evaluate(() => {
        const toggle = document.querySelector("#flat .k2b-section__toggle")!;
        const hit = getComputedStyle(toggle, "::after");
        return { row: toggle.getBoundingClientRect().height, top: Number.parseFloat(hit.top), bottom: Number.parseFloat(hit.bottom) };
      });
      // Engines report sub-pixel layout (WebKit: 27.99999), so compare to the half pixel.
      expect(Math.abs(sizes.row - 28)).toBeLessThan(0.5);
      expect(sizes.row - sizes.top - sizes.bottom).toBeGreaterThanOrEqual(43.5);
    } finally {
      await page.close();
    }
  });

  test("on a phone a heading action moves under the title before the title truncates; an overlong title still truncates", async () => {
    const action = (label: string) =>
      createComponent(Button, {
        variant: "ghost",
        size: "xs",
        get children() {
          return label;
        },
      });
    const section = (id: string, title: string, count: number, label: string) =>
      renderToString(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(Section, {
              id,
              size: "md",
              icon: "ti ti-message-circle",
              title,
              count,
              actions: action(label),
              children: "…",
            });
          },
        }),
      );
    // Contacts on a phone: "Notizen", "Noch keine", and "Kommentar hinzufügen" cut the title to "Not…". The test has no
    // web font, so text widths follow each engine's system font: in the WebKit container this row needs about 298 px,
    // in Chromium about 359 px. A 300 px card is too narrow for it in both, a 350 px card leaves room for "fits".
    const cards = [
      [350, section("fits", "Kommentare", 12, "Neu")],
      [300, section("short", "Notizen", 0, "Kommentar hinzufügen")],
      [300, section("long", "Kommentare aus dem Kundengespräch zur Lieferung im November", 12, "Kommentar hinzufügen")],
    ] as const;
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:1rem">` +
          cards.map(([width, html]) => `<div style="width:${width}px;margin-bottom:1rem">${html}</div>`).join("") +
          `</body></html>`,
      );
      await settled(page);
      const read = (id: string) =>
        page.evaluate((id) => {
          const section = document.getElementById(id)!;
          const header = section.querySelector<HTMLElement>(":scope > header")!;
          const title = section.querySelector<HTMLElement>(".k2b-section__title")!;
          const button = section.querySelector<HTMLElement>(".k2b-section__actions .k2b-button")!;
          const box = section.getBoundingClientRect();
          const buttonBox = button.getBoundingClientRect();
          // What the heading needs on one line: icon, gap, the title's full text, its count or "None yet", gap, action.
          const width = (selector: string) => header.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
          const gap = Number.parseFloat(getComputedStyle(header).columnGap);
          const inner = Number.parseFloat(getComputedStyle(header.querySelector(".k2b-section__heading")!).columnGap);
          const count = width(".k2b-count-chip") + width(".k2b-section__none");
          const oneLine =
            width(".k2b-section__icon") + gap + title.scrollWidth + (count ? inner + count : 0) + gap + width(".k2b-section__actions");
          return {
            tight: oneLine > header.getBoundingClientRect().width + 0.5,
            truncated: title.scrollWidth > title.clientWidth + 0.5,
            actionInside: buttonBox.left >= box.left - 0.5 && buttonBox.right <= box.right + 0.5,
            actionBelowTitle: buttonBox.top >= title.getBoundingClientRect().bottom - 0.5,
            titleInside: title.getBoundingClientRect().right <= box.right + 0.5,
          };
        }, id);
      // Where everything fits, the action stays on the title's line.
      expect(await read("fits")).toEqual({
        tight: false,
        truncated: false,
        actionInside: true,
        actionBelowTitle: false,
        titleInside: true,
      });
      // Too narrow for one line: the title reads whole; the action keeps its full label inside the card on the line below.
      expect(await read("short")).toEqual({ tight: true, truncated: false, actionInside: true, actionBelowTitle: true, titleInside: true });
      // A title longer than the card still ends in an ellipsis inside the card.
      expect(await read("long")).toEqual({ tight: true, truncated: true, actionInside: true, actionBelowTitle: true, titleInside: true });
    } finally {
      await page.close();
    }
  });
});
