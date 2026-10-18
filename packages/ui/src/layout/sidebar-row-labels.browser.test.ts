import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// The shipped faces, so text widths are the same in Chromium and WebKit.
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
// A long label overflows one line in any engine at the 240 px sidebar.
const long = "Rückmeldung zum Projekt Alpha Nord mit allen Anhängen und Notizen";
const TEST_TIMEOUT = 20_000;
const entry = resolve(import.meta.dir, "sidebar-row-labels.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Tag } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [active, setActive] = createSignal(false);
const [unread, setUnread] = createSignal(0);
window.setUnread = setUnread;
const nested = (title) => {
  const row = document.createElement("span");
  row.style.cssText = "display:flex;min-width:0;align-items:center;gap:.375rem";
  const text = document.createElement("span");
  text.className = "k2b-truncate-fade";
  text.textContent = title;
  row.append(text);
  return row;
};
const label = (children, marquee) => createComponent(AppWorkspace.SidebarItemLabel, { children, marquee });
const meta = (visibility) => createComponent(AppWorkspace.SidebarItemMeta, {
  visibility, get children() { return createComponent(Tag, { size: "sm", children: "Table" }); },
});
const rows = [
  { href: "#alpha", children: [label("Rückmeldung zum Projekt Alpha Nord"), meta()] },
  { href: "#beta", children: [label("Rückmeldung zum Projekt Beta Süd"), meta()] },
  { href: "#short", children: label("Inbox") },
  { href: "#weight", get active() { return active(); }, onClick: () => setActive(!active()), children: label("Project Alpha Nord") },
  { href: "#next", children: label("Next row") },
  { href: "#one", children: label(${JSON.stringify(long)}, false) },
  { href: "#two", children: label(${JSON.stringify(`${long} ${long}`)}) },
  // A short title in its own fading span inside the label, with a lock or similar after it, as Notebooks renders it.
  { href: "#nested", children: [label(nested("Hi")), createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label: "More", visibility: "hover" })] },
  { href: "#context", variant: "card", context: "Project Alpha", contextMeta: "2 h", children: [label("Card"), createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label: "More", visibility: "hover" })] },
  { href: "#card", variant: "card", children: label(${JSON.stringify(long)}) },
  { href: "#object", variant: "object", children: label(${JSON.stringify(long)}) },
  { href: "#hover-meta", children: [label("Rückmeldung zum Projekt Beta Süd"), meta("hover")] },
  { href: "#status", meta: createComponent(AppWorkspace.SidebarItemStatus, { unread: 3 }), children: label(${JSON.stringify(long)}) },
  { href: "#live", get meta() { return createComponent(AppWorkspace.SidebarItemStatus, { get unread() { return unread(); } }); }, children: label(${JSON.stringify(long)}) },
  { href: "#after-live", children: label("Next row") },
];
render(() => createComponent(AppWorkspace, {
  resizable: false,
  get children() { return [
    createComponent(AppWorkspace.Sidebar, {
      get children() { return createComponent(AppWorkspace.SidebarDesktop, {
        get children() { return createComponent(AppWorkspace.SidebarBody, {
          get children() { return rows.map(row => createComponent(AppWorkspace.SidebarItem, row)); },
        }); },
      }); },
    }),
    createComponent(AppWorkspace.Content, {
      get children() { return createComponent(AppWorkspace.Main, { children: "Project" }); },
    }),
  ]; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar label fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style><style>*,*::before,*::after{transition:none!important}.k2b-app-workspace__sidebar{--k2b-workspace-sidebar-width:240px}</style></head>` +
      '<body class="k2b-ui" data-theme="light" style="margin:0;--app-accent:#16a34a;--k2b-app-workspace-active:var(--app-accent)"><div id="app" style="height:48rem"></div></body></html>',
  );
  // A face that arrives late changes text widths, which is not the row's doing.
  await page.evaluate(() =>
    Promise.all(
      ["400 12px 'IBM Plex Sans'", "500 13px 'IBM Plex Sans'", "600 12px 'IBM Plex Sans'"].map((font) => document.fonts.load(font)),
    ),
  );
  await page.addScriptTag({ content: script });
  await page.locator('[href="#short"]').waitFor();
  await page.mouse.move(1200, 700);
  return page;
};

const metrics = (page: Page, id: string) =>
  page.locator(`[href="#${id}"]`).evaluate((row) => {
    const text = row.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-label-text")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const boxes = Array.from(range.getClientRects());
    const tops = [...new Set(boxes.map((box) => Math.round(box.top)))];
    // Read the painted characters, including the suffix that distinguishes these names.
    const node = text.firstChild!;
    let visible = "";
    for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const box = range.getBoundingClientRect();
      const clip = text.getBoundingClientRect();
      if (box.bottom <= clip.bottom + 1 && box.right <= clip.right + 1) visible += node.textContent![index];
    }
    return {
      height: row.getBoundingClientRect().height,
      lines: tops.length,
      scrollHeight: text.scrollHeight,
      clientHeight: text.clientHeight,
      visible,
    };
  });

const saveShot = (page: Page, name: string) =>
  page.locator(".k2b-app-workspace__sidebar").screenshot({ path: `/tmp/k2b-ui-sidebar-row-labels-${name}.png` });

describe("sidebar row labels in the browser", () => {
  test(
    "fades only overflowing text, follows resizing and RTL, and leaves row focus and height intact",
    async () => {
      const page = await load();
      const text = (id: string) => page.locator(`[href="#${id}"] .k2b-app-workspace__sidebar-item-label-text`);
      const fadeStates = () =>
        Promise.all(
          ["short", "one", "two"].map((id) =>
            text(id).evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-truncate-fade-on").trim()),
          ),
        );
      const waitForStates = async (expected: string[]) => {
        // Scroll timelines follow new geometry on a later frame.
        for (let attempt = 0; attempt < 50; attempt++) {
          if (JSON.stringify(await fadeStates()) === JSON.stringify(expected)) return;
          await page.waitForTimeout(50);
        }
        expect(await fadeStates()).toEqual(expected);
      };
      try {
        await waitForStates(["0", "1", "1"]);
        // With detection at zero and no overlaid actions, the mask has no dimmed end.
        const short = await text("short").evaluate((element) => ({
          fits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
          opacity: getComputedStyle(element).opacity,
          inset: getComputedStyle(element).getPropertyValue("--k2b-truncate-fade-inset").trim() || "0px",
        }));
        expect(short).toEqual({ fits: true, opacity: "1", inset: "0px" });
        expect(await text("one").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        expect(await text("two").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        const heights = () =>
          Promise.all(
            ["short", "one", "two"].map((id) => page.locator(`[href="#${id}"]`).evaluate((row) => row.getBoundingClientRect().height)),
          );
        const before = await heights();
        const withoutFade = await page.addStyleTag({
          content: ".k2b-truncate-fade-lines { mask-image:none!important; animation:none!important }",
        });
        expect(await heights()).toEqual(before);
        await withoutFade.evaluate((element) => element.parentNode?.removeChild(element));
        await page.keyboard.press("Tab");
        await page.locator('[href="#one"]').focus();
        const focus = await page.locator('[href="#one"]').evaluate((row) => {
          const maskedAncestors: string[] = [];
          for (let element: Element | null = row; element; element = element.parentElement) {
            if (getComputedStyle(element).maskImage !== "none") maskedAncestors.push(element.tagName);
          }
          return { maskedAncestors, outline: getComputedStyle(row).outlineStyle, width: getComputedStyle(row).outlineWidth };
        });
        expect(focus.maskedAncestors).toEqual([]);
        expect(focus.outline).not.toBe("none");
        expect(Number.parseFloat(focus.width)).toBeGreaterThan(0);
        await page.evaluate(() => {
          document.documentElement.dir = "rtl";
        });
        expect(await text("one").evaluate((element) => getComputedStyle(element).maskImage)).toContain("to right");
        // A left-to-right island inside right-to-left text keeps the left-to-right fade.
        expect(
          await text("one").evaluate((element) => {
            element.setAttribute("dir", "ltr");
            const mask = getComputedStyle(element).maskImage;
            element.removeAttribute("dir");
            return mask;
          }),
        ).toStartWith("linear-gradient(to left");
        await page.setViewportSize({ width: 1800, height: 800 });
        await page.locator(".k2b-app-workspace__sidebar").evaluate((element) => {
          (element as HTMLElement).style.setProperty("--k2b-workspace-sidebar-width", "1200px");
        });
        // WebKit re-evaluates scroll timelines lazily inside the workspace: a label that fits after the sidebar grows can
        // keep its fade for seconds, so only Chromium checks that the fade goes away again.
        if (browserName === "chromium") await waitForStates(["0", "0", "0"]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "a nested title and a card's context header keep no covered end under the row's hover action",
    async () => {
      const page = await load();
      try {
        await page.locator('[href="#nested"]').hover();
        const insets = await page.locator('[href="#nested"]').evaluate((row) => {
          const inset = (element: Element) => getComputedStyle(element).getPropertyValue("--k2b-truncate-fade-inset").trim();
          const inner = row.querySelector(".k2b-app-workspace__sidebar-item-label-text .k2b-truncate-fade")!;
          return { outer: inset(row.querySelector(".k2b-app-workspace__sidebar-item-label-text")!), inner: inset(inner) };
        });
        // The outer label fades under the action; the title, narrower than the row, keeps no covered end of its own.
        expect(insets.outer).not.toBe("");
        expect(insets.outer).not.toBe("0px");
        expect(insets.inner).toBe("0px");
        // A card's context header keeps its width when the action shows.
        await page.locator('[href="#context"]').hover();
        expect(
          await page
            .locator('[href="#context"] .k2b-app-workspace__sidebar-item-context-label')
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-truncate-fade-inset").trim()),
        ).toBe("0px");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "ordinary, current and card rows share the neutral hover fill in an accent scope",
    async () => {
      const page = await load();
      try {
        const backgrounds: number[][] = [];
        for (const id of ["short", "weight", "card"]) {
          const row = page.locator(`[href="#${id}"]`);
          if (id === "weight") await row.click();
          await row.hover();
          backgrounds.push(
            await row.evaluate((element) => {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const context = canvas.getContext("2d")!;
              // Painted over white, so the translucent fill reads as the colour people see.
              context.fillStyle = "#fff";
              context.fillRect(0, 0, 1, 1);
              context.fillStyle = getComputedStyle(element).backgroundColor;
              context.fillRect(0, 0, 1, 1);
              return Array.from(context.getImageData(0, 0, 1, 1).data);
            }),
          );
        }
        for (const color of backgrounds) {
          expect(Math.max(...color.slice(0, 3)) - Math.min(...color.slice(0, 3))).toBeLessThanOrEqual(2);
          expect(color[0]).toBeLessThan(255);
        }
        expect(backgrounds[0]).toEqual(backgrounds[1]);
        expect(backgrounds[1]).toEqual(backgrounds[2]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "two balanced lines distinguish long names beside a tag; short labels keep a 2rem row",
    async () => {
      const page = await load();
      try {
        const alpha = await metrics(page, "alpha");
        const beta = await metrics(page, "beta");
        for (const text of [alpha, beta]) {
          expect(text.lines).toBe(2);
          expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);
        }
        expect(alpha.visible).toBe("Rückmeldung zum Projekt Alpha Nord");
        expect(beta.visible).toBe("Rückmeldung zum Projekt Beta Süd");
        expect(alpha.visible).not.toBe(beta.visible);
        const short = await metrics(page, "short");
        expect(short.lines).toBe(1);
        expect(short.height).toBe(32);
        await saveShot(page, "sidebar-rest");
        await page.locator('[href="#alpha"]').hover();
        await saveShot(page, "sidebar-hover");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the selected-weight copy keeps the row and next row in place on selection and hover",
    async () => {
      const page = await load();
      try {
        // Find a real font boundary rather than hard-code a width that depends on the engine.
        const width = await page.evaluate(() => {
          const sidebar = document.querySelector<HTMLElement>(".k2b-app-workspace__sidebar")!;
          const row = document.querySelector<HTMLElement>('[href="#weight"]')!;
          const text = row.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-label-text")!;
          const range = document.createRange();
          range.selectNodeContents(text);
          const lines = () => new Set(Array.from(range.getClientRects()).map((box) => Math.round(box.top))).size;
          for (let width = 120; width <= 400; width++) {
            sidebar.style.setProperty("--k2b-workspace-sidebar-width", `${width}px`);
            text.style.fontWeight = "400";
            const regular = lines();
            text.style.fontWeight = "600";
            const selected = lines();
            if (regular === 1 && selected === 2) {
              text.style.removeProperty("font-weight");
              return width;
            }
          }
          text.style.removeProperty("font-weight");
          return null;
        });
        expect(width).not.toBeNull();
        const geometry = () =>
          page.evaluate(() => ({
            height: document.querySelector('[href="#weight"]')!.getBoundingClientRect().height,
            nextTop: document.querySelector('[href="#next"]')!.getBoundingClientRect().top,
          }));
        const rest = await geometry();
        expect((await metrics(page, "weight")).lines).toBe(1);
        await page.locator('[href="#weight"]').click();
        expect(await page.locator('[href="#weight"]').getAttribute("aria-current")).toBe("page");
        expect((await metrics(page, "weight")).lines).toBe(2);
        expect(await geometry()).toEqual(rest);
        await page.mouse.move(1200, 700);
        expect(await geometry()).toEqual(rest);
        await page.locator('[href="#weight"]').hover();
        expect(await geometry()).toEqual(rest);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "a status that goes from nothing to a count and back keeps the row and the next row in place",
    async () => {
      const page = await load();
      try {
        const geometry = () =>
          page.evaluate(() => ({
            height: document.querySelector('[href="#live"]')!.getBoundingClientRect().height,
            nextTop: document.querySelector('[href="#after-live"]')!.getBoundingClientRect().top,
          }));
        // The long label would take two lines without the status; it keeps one from the first paint.
        const rest = await geometry();
        expect((await metrics(page, "live")).lines).toBe(1);
        expect(rest.height).toBe(32);
        for (const count of [3, 120, 0]) {
          await page.evaluate((value) => (window as unknown as { setUnread: (count: number) => void }).setUnread(value), count);
          expect(await page.locator('[href="#live"] .k2b-app-workspace__sidebar-status-count').count()).toBe(count ? 1 : 0);
          expect(await geometry()).toEqual(rest);
          expect((await metrics(page, "live")).lines).toBe(1);
        }
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "one-line labels, cards and status rows fade out, and hover metadata keeps its box",
    async () => {
      const page = await load();
      try {
        // A live status changes width while shown, so its row stays on one line.
        for (const id of ["one", "card", "object", "status"]) {
          const label = page.locator(`[href="#${id}"] .k2b-app-workspace__sidebar-item-label`);
          if (id !== "status") {
            expect(await label.getAttribute("data-lines")).toBe("1");
            expect(await label.getAttribute("data-label")).toBeNull();
          }
          expect((await metrics(page, id)).lines).toBe(1);
          const overflow = await label.locator(".k2b-app-workspace__sidebar-item-label-text").evaluate((element) => ({
            clipped: element.scrollWidth > element.clientWidth,
            overflow: getComputedStyle(element).overflow,
            textOverflow: getComputedStyle(element).textOverflow,
            mask: getComputedStyle(element).maskImage,
          }));
          expect(overflow.clipped).toBe(true);
          expect(overflow.overflow).toBe("hidden");
          expect(overflow.textOverflow).not.toBe("ellipsis");
          expect(overflow.mask).toContain("linear-gradient");
        }
        const row = page.locator('[href="#hover-meta"]');
        const meta = row.locator(".k2b-app-workspace__sidebar-item-meta");
        const rest = await metrics(page, "hover-meta");
        const metaBox = () =>
          meta.evaluate((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          });
        const box = await metaBox();
        expect(await meta.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
        await row.hover();
        expect(await meta.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
        expect(await metaBox()).toEqual(box);
        expect(await metrics(page, "hover-meta")).toEqual(rest);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
