import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(resolve(tmpdir(), "k2b-ui-view-tabs-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "view-tabs.fixture.tsx");
// Keep real JSX prop getters: preconstructed elements would hide double slot reads.
const fixture = (entry: string) => `
import { createSignal } from "solid-js";
import { AppWorkspace, ViewTabs, IconButton, LocaleProvider } from ${JSON.stringify(entry)};
export function Fixture(props) {
  const labels = {
    en: [{label:"Focus",count:12}, {label:"Needs action",count:12}, {label:"Assigned to me",count:5}, {label:"Waiting for a customer reply",count:2}, {label:"Not assigned",count:4}, {label:"Done"}],
    de: [{label:"Fokus",count:12}, {label:"Wartet auf Antwort",count:2}, {label:"Nicht zugewiesen",count:4}, {label:"Mir zugewiesen",count:5}, {label:"Erledigt"}],
    short: [{label:"List"}, {label:"Board"}],
  };
  const items = labels[props.scenario.labels || "en"].map((item, index) => ({...item, id:String(index+1), href:"?view="+(index+1)}));
  const [current, setCurrent] = createSignal(props.scenario.current || "1");
  if (typeof window !== "undefined") window.setView = setCurrent;
  return <LocaleProvider locale={props.scenario.labels === "de" ? "de" : "en"}>
    <AppWorkspace>
      <AppWorkspace.Head views={<ViewTabs label="Views" items={items} current={current()} />}
        primary={props.scenario.primary === "true" ? { label: "New conversation", icon: "ti ti-plus" } : undefined}
        actions={props.scenario.actions === "false" ? undefined : <>
          <IconButton label="List type"><i class="ti ti-list" aria-hidden="true" /></IconButton>
          <IconButton label="More actions"><i class="ti ti-dots" aria-hidden="true" /></IconButton>
        </>}
      />
      <AppWorkspace.Content><AppWorkspace.Main>Main content</AppWorkspace.Main></AppWorkspace.Content>
    </AppWorkspace>
  </LocaleProvider>;
}
`;
const serverEntry = resolve(import.meta.dir, "view-tabs.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./view-tabs.fixture";
export const render = (scenario) => renderToString(() => createComponent(Fixture, { scenario }));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "view-tabs-ssr",
      setup(builder) {
        builder.onResolve({ filter: /view-tabs\.fixture$/ }, () => ({ path: fixturePath, namespace: "view-tabs-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "view-tabs-fixture" }, async ({ path }) => {
          const result = await transformAsync(fixture(resolve(ui, "src/index.ts")), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
          });
          if (!result?.code) throw new Error("Could not compile server fixture");
          return { contents: result.code, loader: "js", resolveDir: import.meta.dir };
        });
        builder.onLoad({ filter: /\.tsx$/, namespace: "file" }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
          });
          if (!result?.code) throw new Error(`Could not compile ${path}`);
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle ViewTabs SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: (scenario: Record<string, string>) => string; hydrationScript: string } = await import(
  modulePath
);
const clientEntry = resolve(import.meta.dir, "view-tabs.client-fixture.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  target: "browser",
  format: "iife",
  files: {
    [clientEntry]: `import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./view-tabs.fixture";
hydrate(() => createComponent(Fixture, { scenario: Object.fromEntries(new URLSearchParams(location.search)) }), document.getElementById("app"));
document.body.dataset.ready = "true";`,
  },
  plugins: [
    {
      name: "view-tabs-dom",
      setup(builder) {
        builder.onResolve({ filter: /view-tabs\.fixture$/ }, () => ({ path: fixturePath, namespace: "view-tabs-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "view-tabs-fixture" }, async ({ path }) => {
          const result = await transformAsync(fixture(resolve(ui, "dist/browser/index.js")), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "dom", hydratable: true }]],
          });
          if (!result?.code) throw new Error("Could not compile client fixture");
          return { contents: result.code, loader: "js", resolveDir: import.meta.dir };
        });
      },
    },
  ],
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle ViewTabs hydration fixture");
const script = await clientBuild.outputs[0]!.text();
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");

declare global {
  interface Window {
    setView: (id: string) => void;
  }
}

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin: string;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
      const scenario = Object.fromEntries(url.searchParams);
      const hostWidth = Number(scenario.width) || 0;
      return new Response(
        `<!doctype html><html lang="${scenario.labels === "de" ? "de" : "en"}" dir="${scenario.dir === "rtl" ? "rtl" : "ltr"}"><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body class="k2b-ui" style="margin:0"><div id="app" style="container:k2b-app-area / inline-size;height:900px;${hostWidth ? `width:${hostWidth}px` : ""}">${render(scenario)}</div>
<div style="height:1600px" aria-hidden="true"></div>${hydrationScript}</body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 30_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

const listSelector = ".k2b-view-tabs__list";
const load = async (page: Page, scenario: Record<string, string> = {}, hydrate = true) => {
  await page.goto(`${origin}/?${new URLSearchParams(scenario)}`);
  await settled(page);
  if (hydrate) {
    await page.addScriptTag({ url: `${origin}/client.js` });
    await page.waitForSelector('body[data-ready="true"]');
    await settled(page);
  }
};
const snapshot = (page: Page, id?: string, focused = false) =>
  // settled: With an id, change and measure in one evaluate so no microtask, timer, or frame can hide a delayed settle.
  page.evaluate(
    ({ id, focused }) => {
      if (id) window.setView(id);
      const list = document.querySelector<HTMLElement>(".k2b-view-tabs__list")!;
      const current = focused ? document.activeElement : list.querySelector('[aria-current="page"]');
      if (!(current instanceof HTMLElement)) throw new Error("No current/focused tab");
      const bounds = list.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      // scrollFadeEdges normalizes RTL offsets: top is physical left, bottom is physical right.
      const fade = list.getAttribute("data-scroll-fade");
      return {
        id: current.getAttribute("href") ?? current.getAttribute("aria-label"),
        scroll: list.scrollLeft,
        x: window.scrollX,
        y: window.scrollY,
        left: item.left - bounds.left,
        right: bounds.right - item.right,
        leftInset: fade === "top" || fade === "both" ? 16 : 0,
        rightInset: fade === "bottom" || fade === "both" ? 16 : 0,
        outline: getComputedStyle(current).outlineStyle,
        boxes: Array.from(list.querySelectorAll(".k2b-view-tabs__tab"))
          .filter((tab) => tab.getClientRects().length > 0)
          .map((tab) => {
            const { x, y, width, height } = tab.getBoundingClientRect();
            return { x, y, width, height };
          }),
      };
    },
    { id, focused },
  );
const expectVisible = (state: Awaited<ReturnType<typeof snapshot>>) => {
  expect(state.left).toBeGreaterThanOrEqual(state.leftInset - 0.5);
  expect(state.right).toBeGreaterThanOrEqual(state.rightInset - 0.5);
};
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, reducedMotion: "reduce" } as const;

for (const labels of ["en", "de"]) {
  for (const host of ["phone", "640px host"]) {
    test(`${labels} labels and counts keep their max-content width in a ${host}`, async () => {
      const page = await browser!.newPage(host === "phone" ? phone : { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await load(page, { labels, ...(host === "phone" ? {} : { width: "640", primary: "true", current: "4" }) });
        const measurements = await page.locator(listSelector).evaluate((list) => {
          const labels = Array.from(list.querySelectorAll<HTMLElement>(".k2b-view-tabs__label"))
            .filter((label) => label.getClientRects().length > 0)
            .map((label) => ({ text: label.textContent, scroll: label.scrollWidth, width: label.clientWidth }));
          const tabs = Array.from(list.querySelectorAll<HTMLElement>(".k2b-view-tabs__tab"))
            .filter((tab) => tab.getClientRects().length > 0)
            .map((tab) => {
              const li = tab.closest("li")!;
              const clone = li.cloneNode(true);
              if (!(clone instanceof HTMLElement)) throw new Error("Expected a cloned list item");
              clone.style.cssText = "position:absolute;visibility:hidden;width:max-content;flex:none";
              list.append(clone);
              const max = clone.getBoundingClientRect().width;
              const maxTab = clone.querySelector(".k2b-view-tabs__tab")!.getBoundingClientRect().width;
              clone.remove();
              return { text: tab.textContent, width: tab.getBoundingClientRect().width, li: li.getBoundingClientRect().width, max, maxTab };
            });
          return { labels, tabs, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth };
        });
        expect(measurements.scrollWidth).toBeGreaterThan(measurements.clientWidth + 1);
        expect(measurements.labels.length).toBeGreaterThan(0);
        expect(measurements.tabs).toHaveLength(4);
        for (const label of measurements.labels) expect(label.scroll, label.text ?? "label").toBeLessThanOrEqual(label.width);
        for (const tab of measurements.tabs) {
          expect(tab.width, tab.text ?? "tab").toBeGreaterThanOrEqual(tab.maxTab - 0.5);
          expect(tab.li, tab.text ?? "item").toBeGreaterThanOrEqual(tab.max - 0.5);
        }
      } finally {
        await page.close();
      }
    });
  }
}

for (const dir of ["ltr", "rtl"]) {
  test(`the ${dir} server frame settles the current view before hydration and hydration keeps every box`, async () => {
    const page = await browser!.newPage(phone);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /hydrat/i.test(message.text())) errors.push(message.text());
    });
    try {
      await load(page, { current: "5", dir }, false);
      expect(await page.locator("body").getAttribute("data-ready")).toBeNull();
      const before = await snapshot(page);
      expectVisible(before);
      expect(Math.abs(before.scroll)).toBeGreaterThan(0);
      await page.addScriptTag({ url: `${origin}/client.js` });
      await page.waitForSelector('body[data-ready="true"]');
      await settled(page);
      const after = await snapshot(page);
      expectVisible(after);
      expect(after.scroll - before.scroll).toBe(0);
      expect(after.boxes).toHaveLength(before.boxes.length);
      for (const [index, box] of after.boxes.entries()) {
        const previous = before.boxes[index]!;
        for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(box[key] - previous[key])).toBeLessThanOrEqual(0.5);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`in-place views settle synchronously without scrolling the page with motion ${reducedMotion}`, async () => {
    const page = await browser!.newPage({ ...phone, reducedMotion });
    try {
      await load(page);
      await page.evaluate(() => window.scrollTo({ top: 200, behavior: "instant" }));
      await settled(page);
      const position = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      expect(position.y).toBeGreaterThan(0);
      // The fourth view starts behind More and replaces compact slot three.
      const changed = await snapshot(page, "4");
      expect(changed.id).toBe("?view=4");
      expectVisible(changed);
      expect({ x: changed.x, y: changed.y }).toEqual(position);
      await settled(page);
      const settledChange = await snapshot(page);
      expectVisible(settledChange);
      expect(settledChange.scroll).toBe(changed.scroll);
      expect({ x: settledChange.x, y: settledChange.y }).toEqual(position);
      await page.locator(listSelector).evaluate((list) => list.scrollTo({ left: list.scrollWidth, behavior: "instant" }));
      await settled(page);
      const first = await snapshot(page, "1");
      expect(first.id).toBe("?view=1");
      expectVisible(first);
      expect({ x: first.x, y: first.y }).toEqual(position);
      await settled(page);
      const settledFirst = await snapshot(page);
      expectVisible(settledFirst);
      expect(settledFirst.scroll).toBe(first.scroll);
      expect({ x: settledFirst.x, y: settledFirst.y }).toEqual(position);
      // Picking an already-visible view must preserve a person's intermediate scroll position.
      await page.locator(listSelector).evaluate((list) => list.scrollTo({ left: 8, behavior: "instant" }));
      await settled(page);
      const before = await snapshot(page);
      const same = await snapshot(page, "2");
      expectVisible(same);
      expect(same.scroll).toBe(before.scroll);
    } finally {
      await page.close();
    }
  });
}

test("in-place current changes stay visible while another view keeps focus", async () => {
  const page = await browser!.newPage(phone);
  try {
    await load(page);
    await page.keyboard.press("Tab");
    await settled(page);
    await page.evaluate(() => window.setView("5"));
    await settled(page);
    const current = await snapshot(page);
    expect(current.id).toBe("?view=5");
    expectVisible(current);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("?view=1");
  } finally {
    await page.close();
  }
});

for (const dir of ["ltr", "rtl"]) {
  test(`${dir} fades name physical edges at the start, middle, end, and disappear when the strip fits`, async () => {
    const page = await browser!.newPage(phone);
    try {
      await load(page, { dir });
      const list = page.locator(listSelector);
      expect(await list.getAttribute("data-scroll-fade-axis")).toBe("horizontal");
      expect(await list.getAttribute("data-scroll-fade")).toBe(dir === "rtl" ? "top" : "bottom");
      const hidden = await list.evaluate((list) => {
        const bounds = list.getBoundingClientRect();
        const rtl = getComputedStyle(list).direction === "rtl";
        return Array.from(list.querySelectorAll(".k2b-view-tabs__tab"))
          .filter((tab) => tab.getClientRects().length > 0)
          .some((tab) => (rtl ? tab.getBoundingClientRect().left < bounds.left : tab.getBoundingClientRect().right > bounds.right));
      });
      expect(hidden).toBe(true);
      for (const fraction of [0.5, 1]) {
        // Await the native scroll event, so the shared hydration listener must actually update the fade.
        await list.evaluate(
          (list, fraction) =>
            new Promise<void>((done) => {
              list.addEventListener("scroll", () => done(), { once: true });
              list.scrollTo({
                left: (getComputedStyle(list).direction === "rtl" ? -1 : 1) * (list.scrollWidth - list.clientWidth) * fraction,
                behavior: "instant",
              });
            }),
          fraction,
        );
        await settled(page);
        expect(await list.getAttribute("data-scroll-fade")).toBe(fraction === 0.5 ? "both" : dir === "rtl" ? "bottom" : "top");
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await load(page, { labels: "short", dir });
      expect(await page.locator(listSelector).getAttribute("data-scroll-fade")).toBeNull();
      expect(await page.locator(listSelector).getAttribute("data-scroll-fade-axis")).toBe("horizontal");
    } finally {
      await page.close();
    }
  });
}

for (const dir of ["ltr", "rtl"]) {
  test(`${dir} keyboard order keeps views and More outside fades`, async () => {
    const page = await browser!.newPage(phone);
    try {
      await load(page, { dir });
      const expected = await page
        .locator(`${listSelector} .k2b-view-tabs__tab`)
        .evaluateAll((tabs) =>
          tabs.filter((tab) => tab.getClientRects().length > 0).map((tab) => tab.getAttribute("href") ?? tab.getAttribute("aria-label")),
        );
      expect(expected).toHaveLength(4);
      for (const id of expected) {
        await page.keyboard.press("Tab");
        await settled(page);
        const focused = await snapshot(page, undefined, true);
        expect(focused.id).toBe(id);
        expect(focused.outline).not.toBe("none");
        expectVisible(focused);
      }
    } finally {
      await page.close();
    }
  });
}

test("clicking a partially visible phone tab navigates without moving it under the pointer", async () => {
  const page = await browser!.newPage(phone);
  try {
    await load(page);
    await settled(page);
    const { href, x, y } = await page.locator(listSelector).evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      for (const tab of list.querySelectorAll(".k2b-view-tabs__tab")) {
        if (tab.getClientRects().length === 0) continue;
        const rect = tab.getBoundingClientRect();
        if (rect.left >= bounds.left && rect.left < bounds.right && rect.right > bounds.right) {
          const href = tab.getAttribute("href");
          if (!href) throw new Error("Partially visible tab has no navigation href");
          // Press near the strip edge: a reveal on pointer focus would move the tab out from under this point.
          const x = bounds.right - 4;
          if (x <= rect.left) throw new Error("Partially visible tab has no room to click");
          return { href, x, y: rect.top + rect.height / 2 };
        }
      }
      throw new Error("No visible tab extends beyond the list's right edge with its left edge inside");
    });
    await Promise.all([page.waitForURL((url) => url.search === href, { timeout: 5_000 }), page.mouse.click(x, y)]);
  } finally {
    await page.close();
  }
});

test("forced colors drop the edge fade", async () => {
  const page = await browser!.newPage({ ...phone, forcedColors: "active" });
  try {
    await load(page);
    if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
      // This engine does not emulate forced colors.
      return;
    }
    const list = page.locator(listSelector);
    expect(await list.getAttribute("data-scroll-fade")).not.toBeNull();
    expect(
      await list.evaluate((list) => {
        const style = getComputedStyle(list);
        return style.maskImage ?? style.webkitMaskImage;
      }),
    ).toBe("none");
    const decoration = await list.locator('[aria-current="page"]').evaluate((tab) => getComputedStyle(tab).textDecorationLine);
    expect(decoration).not.toBe("none");
    expect(decoration).toContain("underline");
  } finally {
    await page.close();
  }
});

test("German third compact view is visible before hydration", async () => {
  const page = await browser!.newPage(phone);
  try {
    await load(page, { labels: "de", current: "4" }, false);
    expectVisible(await snapshot(page));
  } finally {
    await page.close();
  }
});

test("resizing a narrow workspace host settles the current view again before paint", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await load(page, { width: "640", current: "5" });
    expectVisible(await snapshot(page));
    await page.locator("#app").evaluate((app) => (app.style.width = "390px"));
    await settled(page);
    const resized = await snapshot(page);
    expectVisible(resized);
    expect(Math.abs(resized.scroll)).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test("resizing a narrow workspace host keeps the focused More trigger visible", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await load(page, { width: "640", primary: "true", current: "1" });
    const moreLabel = await page.locator(".k2b-view-tabs__more-trigger").getAttribute("aria-label");
    expect(moreLabel).not.toBeNull();
    let reachedMore = false;
    for (let press = 0; press < 10; press++) {
      await page.keyboard.press("Tab");
      await settled(page);
      reachedMore = await page.evaluate(() => document.activeElement?.matches(".k2b-view-tabs__more-trigger") ?? false);
      if (reachedMore) break;
    }
    expect(reachedMore, "More trigger was not reached after 10 Tab presses").toBe(true);
    await page.locator("#app").evaluate((app) => (app.style.width = "390px"));
    await settled(page);
    const resized = await snapshot(page, undefined, true);
    expect(resized.id).toBe(moreLabel);
    expectVisible(resized);
  } finally {
    await page.close();
  }
});
