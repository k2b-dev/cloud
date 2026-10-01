import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import { type Browser, chromium, type Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

// What a reader sees on the first paint of Book view depends on the shipped
// cascade of Cloud, @k2b/ui and the app's own stylesheet, so a real engine
// lays out the server HTML at desktop and phone widths.
const { default: BookSurface } = await import("./BookSurface");

const render = (navigationHidden: boolean) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(BookSurface, {
          notebookId: "book01",
          notebookName: "Company handbook",
          selectedNoteId: "note02",
          currentHref: "/app/notebooks/book01/notes/note02?mode=book",
          canWrite: false,
          locked: false,
          historyIncomplete: false,
          html: "<h1>Welcome</h1><p>Our handbook explains how the team works together.</p>",
          noteTitle: "Welcome",
          appUrl: "https://cloud.example.test",
          cursor: null,
          tags: [],
          navigationHidden,
          tree: [{ id: "note01", title: "Private folder", children: [{ id: "note02", title: "Welcome", children: [] }] }],
        });
      },
    }),
  );

let browser: Browser;
let css: string;
beforeAll(async () => {
  // The page head's order: the app's stylesheet, then Cloud's global one.
  const stylesheets = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** Book view as the full-page layout places it: a flex column filling the viewport. */
const load = async (width: number, navigationHidden: boolean): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: width < 1024, hasTouch: width < 1024 });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div style="display:flex;flex-direction:column;height:100vh">${render(navigationHidden)}</div></body></html>`,
  );
  return page;
};

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const sidebar = document.getElementById("notebook-navigation");
    const show = document.querySelector('.k2b-icon-button[aria-controls="notebook-navigation"]');
    return {
      sidebar: sidebar ? { display: getComputedStyle(sidebar).display, text: sidebar.textContent ?? "" } : null,
      show: show ? { visible: show.checkVisibility(), box: box(show) } : null,
      main: box(document.querySelector(".notebook-book-main")),
      article: box(document.getElementById("notebook-book-content")),
    };
  });

describe("Book view with the notebook navigation hidden", () => {
  test("at 1440 px the first paint has no contents list, the page takes the full width and the show control sits bottom-left", async () => {
    const visiblePage = await load(1440, false);
    const hiddenPage = await load(1440, true);
    try {
      const visible = await layout(visiblePage);
      const hidden = await layout(hiddenPage);
      expect(visible.sidebar?.text).toContain("Private folder");
      expect(visible.show).toBeNull();

      expect(hidden.sidebar).toEqual({ display: "none", text: "" });
      // Only the workspace's 1 px edge stays left of the page.
      expect(hidden.main!.left).toBeLessThanOrEqual(1);
      expect(hidden.main!.width - visible.main!.width).toBe(visible.main!.left - hidden.main!.left);
      expect(hidden.show?.visible).toBe(true);
      expect(hidden.show!.box!.left).toBeLessThan(40);
      expect(hidden.show!.box!.top + hidden.show!.box!.height).toBeGreaterThan(800 - 40);
    } finally {
      await visiblePage.close();
      await hiddenPage.close();
    }
  });

  test("at 390 px the phone layout is the same with a hidden or visible navigation", async () => {
    const visiblePage = await load(390, false);
    const hiddenPage = await load(390, true);
    try {
      const visible = await layout(visiblePage);
      const hidden = await layout(hiddenPage);
      expect(visible.sidebar?.display).toBe("none");
      expect(hidden.sidebar?.display).toBe("none");
      // Phones keep the contents in the header menu, so no extra control appears.
      expect(hidden.show?.visible).toBe(false);
      expect(hidden.main).toEqual(visible.main);
      expect(hidden.article).toEqual(visible.article);
    } finally {
      await visiblePage.close();
      await hiddenPage.close();
    }
  });
});
