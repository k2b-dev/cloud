import { afterAll, beforeAll, describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, pressAcrossRebuild } from "../../test/browser";

// Hosts rebuild equal items whenever their inputs change. A row replaced between press and release swallows the
// click (#2140), so each list here must keep its row elements across a rebuild.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "rebuilt-rows.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Dropdown, prompts, Tabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [generation, setGeneration] = createSignal(0);
const [tab, setTab] = createSignal("first");
window.chosen = [];
window.rebuild = () => setGeneration((value) => value + 1);
// A search answers at once, or holds its answer until the test releases it, with new objects for the same results.
window.openSearch = () =>
  void prompts
    .search(
      () => {
        const answer = () => [
          { id: "ada", label: "Ada", value: "ada" },
          { id: "grace", label: "Grace", value: "grace" },
        ];
        if (!window.holdSearch) return answer();
        return new Promise((resolve) => {
          window.releaseSearch = () => resolve(answer());
        });
      },
      { title: "Find people", debounceMs: 0 },
    )
    .then((item) => item?.value && window.chosen.push(item.value));
const root = document.getElementById("root");
render(
  () => [
    createComponent(Dropdown.Root, {
      get items() {
        generation();
        return [
          { label: "Rename", action: () => window.chosen.push("rename") },
          { sectionLabel: "Move", items: [{ label: "Archive", action: () => window.chosen.push("archive") }] },
        ];
      },
      get children() {
        return createComponent(Dropdown.Trigger, { children: "Actions" });
      },
    }),
    createComponent(Tabs, {
      ariaLabel: "Sections",
      get value() {
        return tab();
      },
      onValueChange: (value) => {
        window.chosen.push(value);
        setTab(value);
      },
      get options() {
        generation();
        return [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ];
      },
    }),
  ],
  root,
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the rebuilt-rows fixture for the browser.");
const script = await build.outputs[0]!.text();

declare global {
  interface Window {
    chosen: string[];
    rebuild: () => void;
    openSearch: () => void;
    holdSearch?: boolean;
    releaseSearch?: () => void;
  }
}

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><main id="root" style="padding:2rem"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};
const rebuild = (page: Page) => () => page.evaluate(() => window.rebuild());

describe(`rows survive a host rebuild between press and release in ${browserName}`, () => {
  for (const [name, label, expected] of [
    ["a menu action", "Rename", "rename"],
    ["an action in a menu section", "Archive", "archive"],
  ] as const)
    test(`${name} runs`, async () => {
      const page = await open();
      try {
        await page.getByRole("button", { name: "Actions", exact: true }).click();
        await pressAcrossRebuild(page, page.getByRole("menuitem", { name: label, exact: true }), rebuild(page));
        await page.waitForFunction((value) => window.chosen.includes(value), expected, { timeout: 2_000 });
      } finally {
        await page.close();
      }
    });

  test("a tab is chosen", async () => {
    const page = await open();
    try {
      await pressAcrossRebuild(page, page.getByRole("tab", { name: "Second", exact: true }), rebuild(page));
      await page.waitForFunction(() => window.chosen.includes("second"), undefined, { timeout: 2_000 });
    } finally {
      await page.close();
    }
  });

  test("a search result is chosen when a newer answer with the same result lands", async () => {
    const page = await open();
    try {
      await page.evaluate(() => window.openSearch());
      const row = page.getByRole("option", { name: "Grace", exact: true });
      await row.waitFor();
      await page.evaluate(() => {
        window.holdSearch = true;
      });
      await page.getByRole("combobox").press("e");
      await page.waitForFunction(() => window.releaseSearch !== undefined, undefined, { timeout: 2_000 });
      await pressAcrossRebuild(page, row, async () => {
        await page.evaluate(() => window.releaseSearch?.());
        // A new answer makes its first row active again.
        await page.locator('[role="option"][data-active="true"]').filter({ hasText: "Ada" }).waitFor({ timeout: 2_000 });
      });
      await page.waitForFunction(() => window.chosen.includes("grace"), undefined, { timeout: 2_000 });
    } finally {
      await page.close();
    }
  });
});
