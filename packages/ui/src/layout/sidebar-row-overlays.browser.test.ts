import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Whether a revealed row control covers another one, or a label scrolls into
// its fade, depends on layout and paint, which happy-dom does not model, so a
// real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// A laptop with a touch screen hovers with its fine primary pointer and also
// has a coarse one. Chromium emulates only one pointer, so its rules are forced on.
const stylesheets = { fine: css, hybrid: css.replaceAll("(any-pointer:coarse)", "(min-width:0)") };
type Mode = keyof typeof stylesheets;

// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "sidebar-row-overlays.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, IconButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const label = (children) => createComponent(AppWorkspace.SidebarItemLabel, { children });
const action = (label, visibility) => createComponent(AppWorkspace.SidebarItemAction, { icon: "ti ti-dots", label, visibility });
const button = (label) => createComponent(IconButton, { label, size: "xs", variant: "ghost", children: "+" });
const preview = (label, trigger) => ({ label, trigger, content: label });
// Every supported combination of trailing row controls.
const rows = () => [
  { href: "#hover", children: [label("Hover action"), action("Row actions", "hover")] },
  { href: "#preview", preview: preview("Info"), children: [label("Preview")] },
  { href: "#hover-preview", preview: preview("Details"), children: [label("Hover action and preview"), action("Reopen", "hover")] },
  { preview: preview("Open menu", "row"), children: [label("Chevron")] },
  { preview: preview("Open shared", "row"), children: [label("Hover action and chevron"), action("More", "hover")] },
  { href: "#visible-preview", preview: preview("Checklist details"), children: [label("Visible action and preview"), action("Done")] },
  {
    href: "#group-preview",
    preview: preview("Review details"),
    get actions() {
      return createComponent(AppWorkspace.SidebarItemActions, {
        get children() {
          return [button("Pin"), button("Share")];
        },
      });
    },
    children: [label("Action group and preview")],
  },
  { preview: preview("Open archive", "row"), children: [label("Visible action and chevron"), action("Archive")] },
  { href: "#count", meta: "12", children: [label("Count and hover action"), action("Inbox actions", "hover")] },
];

render(
  () =>
    createComponent(AppWorkspace, {
      resizable: false,
      get children() {
        return [
          createComponent(AppWorkspace.Sidebar, {
            get children() {
              return createComponent(AppWorkspace.SidebarDesktop, {
                get children() {
                  return createComponent(AppWorkspace.SidebarBody, {
                    get children() {
                      return createComponent(AppWorkspace.SidebarSection, {
                        title: "Rows",
                        get children() {
                          return rows().map((row) => createComponent(AppWorkspace.SidebarItem, row));
                        },
                      });
                    },
                  });
                },
              });
            },
          }),
          createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, { children: "Board" });
            },
          }),
        ];
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar row fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (mode: Mode, options: { motion?: boolean; rtl?: boolean } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Transitions only delay the settled state; the marquee moves a label on purpose.
  const still = `*,*::before,*::after{transition:none!important${options.motion ? "" : ";animation:none!important"}}`;
  // The shipped stylesheet resolves logical properties by language, as older engines need.
  const direction = options.rtl ? ' lang="ar" dir="rtl"' : ' lang="en"';
  await page.setContent(
    `<!doctype html><html${direction}><head><style>${stylesheets[mode]}</style><style>${still}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.getByText("Count and hover action").waitFor();
  await page.mouse.move(1400, 880);
  return page;
};

const row = (page: Page, label: string) =>
  page.locator(".k2b-app-workspace__sidebar-item", { has: page.getByText(label, { exact: true }) });

/**
 * Inspects the sidebar in its current hover and focus state. Every box must
 * keep the size and position it had at `rest`, and every control the row
 * holding `label` shows must be what a click at its centre reaches.
 */
const inspect = (page: Page, label: string, rest: string[] | null) =>
  page.evaluate(
    ({ label, rest }) => {
      const sidebar = document.querySelector(".k2b-app-workspace__sidebar")!;
      // The preview panel opens beside its row in the top layer.
      const boxes = Array.from(sidebar.querySelectorAll("*"))
        .filter((element) => !element.closest(".k2b-app-workspace__sidebar-preview"))
        .map((element) => {
          const box = element.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height].map((value) => value.toFixed(2)).join(" ");
        });
      const problems = boxes.flatMap((box, index) =>
        rest && box !== rest[index] ? [`box ${index} moved from ${rest[index]} to ${box}`] : [],
      );
      const name = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
      const owner = Array.from(sidebar.querySelectorAll(".k2b-app-workspace__sidebar-item")).find(
        (element) => element.querySelector(".k2b-app-workspace__sidebar-item-label")?.textContent?.trim() === label,
      )!;
      const shown = (element: Element) => {
        for (let node: Element | null = element; node && node !== owner; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.opacity !== "1" || style.pointerEvents === "none" || style.display === "none") return false;
        }
        return true;
      };
      const controls = Array.from(
        owner.querySelectorAll(":scope > .k2b-app-workspace__sidebar-item-action, :scope > .k2b-app-workspace__sidebar-item-actions > *"),
      );
      for (const control of controls.filter(shown)) {
        const box = control.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        if (!hit || !control.contains(hit)) problems.push(`${name(control)} is covered by ${hit ? name(hit) : "nothing"}`);
      }
      const focused = document.activeElement;
      if (focused && controls.includes(focused) && !shown(focused)) problems.push(`${name(focused)} has focus but is hidden`);
      return { boxes, problems, shown: controls.filter(shown).map(name) };
    },
    { label, rest },
  );

const labels = [
  "Hover action",
  "Preview",
  "Hover action and preview",
  "Chevron",
  "Hover action and chevron",
  "Visible action and preview",
  "Action group and preview",
  "Visible action and chevron",
  "Count and hover action",
];

describe("@k2b/ui sidebar row controls", () => {
  for (const mode of ["fine", "hybrid"] as const) {
    test(`${mode} pointer: hover and keyboard reveal row controls without moving a box or covering another control`, async () => {
      const page = await load(mode);
      try {
        const rest = (await inspect(page, labels[0]!, null)).boxes;
        const problems: string[] = [];
        const hovered: Record<string, string[]> = {};
        for (const label of labels) {
          const box = (await row(page, label).boundingBox())!;
          await page.mouse.move(box.x + 12, box.y + box.height / 2);
          const result = await inspect(page, label, rest);
          problems.push(...result.problems.map((problem) => `${label} hovered: ${problem}`));
          hovered[label] = result.shown;
        }
        await page.mouse.move(1400, 880);

        const previewFocused: Record<string, string[]> = {};
        let reached = false;
        for (let step = 0; step < 40; step += 1) {
          await page.keyboard.press("Tab");
          const stop = await page.evaluate(() => {
            const focused = document.activeElement;
            const owner = focused?.closest(".k2b-app-workspace__sidebar-item");
            if (!focused || !owner) return null;
            return {
              label: owner.querySelector(".k2b-app-workspace__sidebar-item-label")?.textContent?.trim() ?? "",
              control: focused.getAttribute("aria-label") ?? focused.textContent?.trim() ?? "",
              preview: focused.matches(".k2b-app-workspace__sidebar-preview-trigger:not([data-row-trigger])"),
            };
          });
          if (!stop) {
            if (reached) break;
            continue;
          }
          reached = true;
          const result = await inspect(page, stop.label, rest);
          problems.push(...result.problems.map((problem) => `${stop.label} with focus on ${stop.control}: ${problem}`));
          if (stop.preview) previewFocused[stop.label] = result.shown;
        }

        expect(problems).toEqual([]);
        const touch = mode === "hybrid";
        expect(hovered).toEqual({
          "Hover action": ["Row actions"],
          // An action preview opens on hover, so a fine pointer alone never needs its button.
          Preview: touch ? ["Info"] : [],
          "Hover action and preview": touch ? ["Reopen", "Details"] : ["Reopen"],
          Chevron: ["Open menu"],
          "Hover action and chevron": ["More", "Open shared"],
          "Visible action and preview": touch ? ["Done", "Checklist details"] : ["Done"],
          "Action group and preview": touch ? ["Pin", "Share", "Review details"] : ["Pin", "Share"],
          "Visible action and chevron": ["Archive", "Open archive"],
          "Count and hover action": ["Inbox actions"],
        });
        // With a fine pointer alone, the focused preview button takes the place of the control before it.
        expect(previewFocused).toEqual({
          Preview: ["Info"],
          "Hover action and preview": touch ? ["Reopen", "Details"] : ["Details"],
          "Visible action and preview": touch ? ["Done", "Checklist details"] : ["Checklist details"],
          "Action group and preview": touch ? ["Pin", "Share", "Review details"] : ["Pin", "Review details"],
        });
      } finally {
        await page.close();
      }
    });
  }

  test("the marquee of a hovered label ends clear of the fade before a revealed action", async () => {
    const page = await load("fine", { motion: true });
    try {
      const ends: Record<string, number> = {};
      // One label overflows its row; the other fits but ends where the action appears.
      for (const [label, extra] of [
        ["Hover action", 60],
        ["Hover action and preview", -16],
      ] as const) {
        const text = row(page, label).locator(".k2b-app-workspace__sidebar-item-label-text");
        await text.evaluate((element, extra) => {
          element.style.width = `${element.parentElement!.clientWidth + extra}px`;
        }, extra);
        const box = (await text.boundingBox())!;
        await page.mouse.move(box.x + 8, box.y + box.height / 2);
        // The workspace controller measures the label in the frame after the pointer enters it.
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        ends[label] = await row(page, label).evaluate((element) => {
          const text = element.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-label-text")!;
          // The marquee holds its far end from 85 % of its 4 s run, after a 0.2 s delay.
          for (const marquee of text.getAnimations()) {
            marquee.pause();
            marquee.currentTime = 200 + 4000 * 0.9;
          }
          const action = element.querySelector(
            ":scope > .k2b-app-workspace__sidebar-item-action:not(.k2b-app-workspace__sidebar-preview-trigger)",
          )!;
          return action.getBoundingClientRect().left - text.getBoundingClientRect().right;
        });
        await page.mouse.move(1400, 880);
      }
      // The label fades over 0.75rem before the action, so the text ends at least that far before it.
      expect(Object.entries(ends).filter(([, gap]) => gap < 12)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("the label fades on the side where a right-to-left row reveals its action", async () => {
    const page = await load("fine", { rtl: true });
    try {
      const target = row(page, "Hover action");
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
      const result = await target.evaluate((element) => {
        const action = element.querySelector(":scope > .k2b-app-workspace__sidebar-item-action")!.getBoundingClientRect();
        const row = element.getBoundingClientRect();
        return {
          actionAtLeftEdge: Math.abs(action.left - row.left) < 1,
          mask: getComputedStyle(element.querySelector(".k2b-app-workspace__sidebar-item-label")!).maskImage,
        };
      });
      expect(result.actionAtLeftEdge).toBe(true);
      expect(result.mask).toStartWith("linear-gradient(to right,");
    } finally {
      await page.close();
    }
  });
});
