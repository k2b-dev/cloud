import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../../ui/test/browser";

// What a reader sees on the first paint of Book view depends on the shipped
// cascade of Cloud, @k2b/ui and the app's own stylesheet, so a real engine
// lays out the server HTML at desktop and phone widths.
const { default: BookSurface } = await import("./BookSurface");

const welcome = "<h1>Welcome</h1><p>Our handbook explains how the team works together.</p>";
const sentence = "The team agreed on the next steps and noted who follows up with the other departments. ";
// Meeting notes as a long bullet list. The reader is near the end of a long point, where a rewrap moves the text furthest.
const point = (index: number) =>
  index === 20 ? `${sentence.repeat(27)}<span id="reading">Here</span> ${sentence.repeat(3)}` : sentence.repeat((index % 3) + 2);
const longNote = `<h1>Welcome</h1><p>${sentence}</p><ul>${Array.from({ length: 40 }, (_, index) => `<li>Point ${index + 1}: ${point(index + 1)}</li>`).join("")}</ul>`;

const render = (navigationHidden: boolean, html = welcome) =>
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
          html,
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

// Hides and shows the navigation the way Book view's islands do, around the reading position helper.
const fixtureEntry = resolve(import.meta.dir, "book-reading-position.fixture.ts");
const fixture = `
import { keepBookReadingPosition } from ${JSON.stringify(resolve(import.meta.dir, "book-reading-position.ts"))};

const frame = () => new Promise((settle) => requestAnimationFrame(settle));

window.run = async ({ keep }) => {
  const main = document.querySelector(".notebook-book-main");
  const article = document.getElementById("notebook-book-content");
  const sidebar = document.getElementById("notebook-navigation");
  const contents = Array.from(sidebar.childNodes);
  const handle = document.querySelector('[data-app-workspace-resize="sidebar"]');
  const handlePlace = [handle.parentNode, handle.nextSibling];
  // The widest navigation a reader can drag it to.
  document.querySelector(".k2b-app-workspace").style.setProperty("--k2b-workspace-sidebar-width", "360px");
  const reading = document.getElementById("reading");
  /** Where the line the reader is on sits, relative to the scroll port's top edge. */
  const offset = () => Math.round(reading.getBoundingClientRect().top - main.getBoundingClientRect().top);
  main.scrollTop += offset() - 40;
  await frame();
  const result = { before: offset(), widths: [Math.round(article.getBoundingClientRect().width)], steps: [] };
  for (const hidden of [true, false]) {
    const restore = keep ? keepBookReadingPosition(article, main) : () => {};
    // A hidden navigation renders an empty sidebar without its resize handle.
    sidebar.hidden = hidden;
    if (hidden) {
      sidebar.replaceChildren();
      handle.remove();
    } else {
      sidebar.append(...contents);
      handlePlace[0].insertBefore(handle, handlePlace[1]);
    }
    await Promise.resolve();
    restore();
    // Every painted frame after the change, read before the next paint.
    const painted = [];
    for (let i = 0; i < 4; i++) {
      await frame();
      painted.push(offset());
    }
    result.widths.push(Math.round(article.getBoundingClientRect().width));
    result.steps.push(painted);
  }
  return result;
};
`;

let browser: Browser;
let css: string;
let script: string;
beforeAll(async () => {
  const fixtureBuild = await Bun.build({
    entrypoints: [fixtureEntry],
    files: { [fixtureEntry]: fixture },
    target: "browser",
    format: "iife",
  });
  if (!fixtureBuild.success) throw new AggregateError(fixtureBuild.logs, "Could not bundle the reading position fixture.");
  script = await fixtureBuild.outputs[0]!.text();
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
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** Book view as the full-page layout places it: a flex column filling the viewport. */
const load = async (width: number, navigationHidden: boolean, html?: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: width < 1024, hasTouch: width < 1024 });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div style="display:flex;flex-direction:column;height:100vh">${render(navigationHidden, html)}</div></body></html>`,
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

type Run = { before: number; widths: number[]; steps: [hidden: number[], shown: number[]] };

const run = async (keep: boolean): Promise<Run> => {
  // At 1024 px a wide navigation leaves the article narrower than its reading width.
  const page = await load(1024, false, longNote);
  try {
    await page.addScriptTag({ content: script });
    return (await page.evaluate(`window.run(${JSON.stringify({ keep })})`)) as Run;
  } finally {
    await page.close();
  }
};

/** The line moves by less than two of the article's 28 px lines; without help it leaves the view. */
const steady = (offsets: number[], expected: number) => offsets.every((offset) => Math.abs(offset - expected) < 56);

describe("Book view reading position when the navigation hides and shows", () => {
  test("keeps the text the reader is on in place while the article rewraps, and returns to it exactly", async () => {
    const result = await run(true);
    expect(Math.abs(result.before - 40)).toBeLessThanOrEqual(1);
    expect(result.widths[1]).toBeGreaterThan(result.widths[0]!);
    expect(result.widths[2]).toBe(result.widths[0]!);
    const [hidden, shown] = result.steps;
    expect({ hidden, steady: steady(hidden, result.before) }).toEqual({ hidden, steady: true });
    // Showing the navigation again restores the reader's first view.
    expect(shown.every((offset) => Math.abs(offset - result.before) <= 1)).toBe(true);
    // No later correction either: the first painted frame is the final position.
    for (const painted of result.steps) expect(new Set(painted).size).toBe(1);
  });

  test("without it the browser's scroll anchoring lets the text the reader is on move out of view", async () => {
    const result = await run(false);
    expect(result.steps.some((painted) => !steady(painted, result.before))).toBe(true);
  });
});
