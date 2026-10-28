import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import type { SearchItem, SearchStreamLine } from "../api/search/schemas";

// Whether rows that arrive later move the ones already shown depends on real layout, so this runs in a browser
// against a server that streams invented results line by line.
const ui = resolve(import.meta.dir, "../../../ui");

/** The real search islands, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CloudResourceSearch.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-search-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Search harness build failed");
  return build.outputs[0]!.text();
};

const apps = [
  { id: "files", name: "Files", icon: "ti ti-folder" },
  { id: "mail", name: "Mail", icon: "ti ti-mail" },
  { id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" },
];
const result = (appId: string, title: string, preview: string): SearchItem => ({
  appId,
  appName: apps.find((app) => app.id === appId)!.name,
  appIcon: apps.find((app) => app.id === appId)!.icon,
  readable: true,
  ref: { type: `${appId}.item`, id: title },
  title,
  preview,
  href: `/app/${appId}`,
});
const line = (provider: string, results: SearchItem[], status = results.length ? "ok" : "empty"): SearchStreamLine => ({
  type: "provider",
  provider,
  status: status as "ok",
  results,
  ms: 10,
});

/** A provider that answers only when the test opens it. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};
type Answer = (url: URL, write: (line: SearchStreamLine) => void) => Promise<void>;
let answer: Answer = async () => {};
const searches: URL[] = [];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname !== "/api/search") {
        if (url.pathname !== "/") return new Response(null, { status: 404 });
        const lang = url.searchParams.get("lang") ?? "en";
        return new Response(
          `<!doctype html><html lang="${lang}" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<style>${css}</style></head><body class="k2b-ui"><script src="/harness.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      searches.push(url);
      const encoder = new TextEncoder();
      const query = url.searchParams.get("q") ?? "";
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (value: SearchStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          if (!query) write({ type: "start", query, apps, providers: [] });
          else await answer(url, write);
          write({ type: "done", status: "complete", count: 0 });
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type View = { width: number; height: number; touch: boolean };
const views: View[] = [
  { width: 1440, height: 900, touch: false },
  { width: 390, height: 844, touch: true },
];

const open = async (view: View, path = "/") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}${path}`);
  await page.locator('input[role="combobox"]').waitFor();
  return { page, close: () => context.close() };
};

/** Positions of the dialog and every result row, in CSS pixels. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
    };
    return {
      dialog: box(document.querySelector("dialog")!),
      rows: Array.from(document.querySelectorAll('[role="option"]')).map(box),
      status: document.querySelector(".cloud-resource-search__status")?.textContent ?? "",
      selected: document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
const waitForRows = (page: Page, count: number) =>
  page.waitForFunction((expected) => document.querySelectorAll('[role="option"]').length === expected, count);
const waitForText = (page: Page, text: string) => page.locator("dialog").getByText(text, { exact: false }).first().waitFor();

describe("streamed search in a browser", () => {
  test("a picked resource uses the opener app's fill without moving, while keyboard activity keeps the platform fill", async () => {
    answer = async (_url, write) => {
      write({ type: "start", query: "plan", apps, providers: ["files"] });
      write(line("files", [result("files", "Plan 2027.pdf", "Planning"), result("files", "Project plan.docx", "Drafts")]));
    };
    const { page, close } = await open(views[0]!, "/?picker&accent=%230f766e");
    try {
      await page.keyboard.type("plan");
      await waitForRows(page, 2);
      const firstRow = page.locator(".cloud-resource-search__result").first();
      const before = await firstRow.boundingBox();
      expect(before).not.toBeNull();
      await page.keyboard.press("Enter");
      const picked = page.locator(".cloud-resource-search__result.is-selected");
      await picked.waitFor();
      expect(await picked.boundingBox()).toEqual(before);
      await page.keyboard.press("ArrowDown");
      const active = page.locator(".cloud-resource-search__result.is-active:not(.is-selected)");
      await active.waitFor();
      const colors = await picked.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;background:var(--ui-app-selected)";
        document.body.append(probe);
        const appFill = getComputedStyle(probe).backgroundColor;
        // Outside the body scope, the probe reads the `:root` default.
        document.documentElement.append(probe);
        const defaultFill = getComputedStyle(probe).backgroundColor;
        document.body.append(probe);
        probe.style.background = "var(--k2b-selected)";
        const platformFill = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { pickedFill: getComputedStyle(element).backgroundColor, appFill, defaultFill, platformFill };
      });
      expect(colors.pickedFill).toBe(colors.appFill);
      expect(colors.pickedFill).not.toBe(colors.defaultFill);
      expect(colors.pickedFill).not.toBe(colors.platformFill);
      expect(await active.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(colors.platformFill);
      expect(await picked.boundingBox()).toEqual(before);
    } finally {
      await close();
    }
  }, 30_000);

  test("a phone shows the picker as a full-screen sheet and keeps global search floating", async () => {
    for (const [path, sheet] of [
      ["/?picker", true],
      ["/", false],
    ] as const) {
      const { page, close } = await open(views[1]!, path);
      try {
        const { left, top, width, bottom } = await page.locator("dialog").evaluate((dialog) => {
          const rect = dialog.getBoundingClientRect();
          return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), bottom: Math.round(rect.bottom) };
        });
        if (sheet) {
          expect([left, width]).toEqual([0, 390]);
          expect(top).toBeLessThanOrEqual(12);
          expect(bottom).toBe(844);
        } else {
          expect(left).toBeGreaterThan(0);
          expect(bottom).toBeLessThan(844);
        }
      } finally {
        await close();
      }
    }
  }, 30_000);

  test("shows each app as it answers, appends slower apps below, and moves nothing already shown", async () => {
    for (const view of views) {
      const files = gate();
      const mail = gate();
      answer = async (_url, write) => {
        write({ type: "start", query: "plan", apps, providers: ["files", "mail", "notebooks"] });
        write(line("notebooks", []));
        await files.opened;
        write(
          line("files", [
            result("files", "Plan 2027.pdf", "Shared/Planning"),
            result("files", "Project plan.docx", "Team/Drafts"),
            result("files", "Floor plan.png", "Office"),
          ]),
        );
        await mail.opened;
        write(line("mail", [result("mail", "Plan for Monday", "Anna Beispiel"), result("mail", "Re: Plan", "Jonas Beispiel")]));
      };
      const { page, close } = await open(view);
      try {
        await page.keyboard.type("plan");
        await waitForText(page, "Files and Mail are still searching…");
        const searching = await layout(page);
        expect(searching.rows).toEqual([]);
        expect(await page.locator("dialog").textContent()).not.toContain("No matches");

        files.open();
        await waitForRows(page, 3);
        await waitForText(page, "Mail is still searching…");
        const first = await layout(page);
        // The status line sits below the results.
        await settled(page);
        const statusTop = await page.locator(".cloud-resource-search__status").evaluate((element) => element.getBoundingClientRect().top);
        expect(statusTop).toBeGreaterThanOrEqual(first.rows[2]![1]! + first.rows[2]![3]!);
        await page.keyboard.press("ArrowDown");
        expect((await layout(page)).selected).toContain("Project plan.docx");

        mail.open();
        await waitForRows(page, 5);
        await page.locator(".cloud-resource-search__status").waitFor({ state: "detached" });
        const done = await layout(page);
        // One dialog size from the first keystroke to the last app, and the first rows never move.
        expect({ width: view.width, dialog: [first.dialog, done.dialog], rows: done.rows.slice(0, 3) }).toEqual({
          width: view.width,
          dialog: [searching.dialog, searching.dialog],
          rows: first.rows,
        });
        expect(done.selected).toContain("Project plan.docx");
        expect(done.overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("says that nothing was found only after every app has answered", async () => {
    const mail = gate();
    answer = async (_url, write) => {
      write({ type: "start", query: "zebra", apps, providers: ["files", "mail"] });
      write(line("files", []));
      await mail.opened;
      write(line("mail", []));
    };
    const { page, close } = await open(views[0]!);
    try {
      await page.keyboard.type("zebra");
      await waitForText(page, "Mail is still searching…");
      const searching = await layout(page);
      expect(await page.locator("dialog").textContent()).not.toContain("No matches");
      mail.open();
      await waitForText(page, "No matches. Try another search term.");
      expect((await layout(page)).dialog).toEqual(searching.dialog);
    } finally {
      await close();
    }
  }, 30_000);

  test("names an app that did not answer in time and searches only that app again", async () => {
    answer = async (url, write) => {
      if (url.searchParams.get("app") === "mail") {
        write({ type: "start", query: "budget", apps, providers: ["mail"] });
        write(line("mail", [result("mail", "Budget 2027", "Finance")]));
        return;
      }
      write({ type: "start", query: "budget", apps, providers: ["files", "mail"] });
      write(line("files", [result("files", "Budget.xlsx", "Finance")]));
      write(line("mail", [], "timeout"));
    };
    for (const view of views) {
      const { page, close } = await open(view);
      try {
        await page.keyboard.type("budget");
        await waitForText(page, "Mail did not respond in time");
        const before = await layout(page);
        expect(before.rows).toHaveLength(1);
        const count = searches.length;
        await page.locator(".cloud-resource-search__status").getByRole("button", { name: "Try again" }).click();
        await waitForRows(page, 2);
        expect(searches.slice(count).map((url) => url.searchParams.get("app"))).toEqual(["mail"]);
        const after = await layout(page);
        expect(after.rows[0]).toEqual(before.rows[0]!);
        expect(after.dialog).toEqual(before.dialog);
        expect(after.status).toBe("");
        expect(after.overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    }
  }, 60_000);

  test("gives a picker narrowed to one app one clear state, in English and German", async () => {
    answer = async (url, write) => {
      write({ type: "start", query: url.searchParams.get("q") ?? "", apps, providers: ["mail"] });
      write(line("mail", []));
    };
    for (const [lang, text] of [
      ["en", "Mail: no matches for “invoice”"],
      ["de", "Mail: keine Treffer für „invoice“"],
    ] as const) {
      const { page, close } = await open(views[1]!, `/?picker&app=mail&lang=${lang}`);
      try {
        await page.keyboard.type("invoice");
        await waitForText(page, text);
        expect(searches.at(-1)?.searchParams.get("app")).toBe("mail");
      } finally {
        await close();
      }
    }
  }, 30_000);
});

for (const lang of ["en", "de"]) {
  test(`app launcher uses localized shell names, aliases and keyboard/new-tab navigation (${lang})`, async () => {
    searches.length = 0;
    const view = await open(views[0]!, `/?launcher&public&admin&lang=${lang}`);
    const { page } = view;
    try {
      expect(await page.locator('[role="option"]').count()).toBe(0);
      const input = page.locator('input[role="combobox"]');
      await input.fill("admin");
      await waitForRows(page, 1);
      const option = page.getByRole("option");
      expect(await option.innerText()).toContain(lang === "de" ? "Administration" : "Admin");
      expect(await option.locator("small").innerText()).toBe("App");
      expect(await option.locator("i").getAttribute("class")).toBe("ti ti-settings");
      for (const modifier of ["Control", "Meta"]) {
        const popup = page.waitForEvent("popup");
        await input.press(`${modifier}+Enter`);
        const tab = await popup;
        await tab.waitForURL("**/admin");
        await tab.close();
        expect(await input.inputValue()).toBe("admin");
        expect(await option.getAttribute("aria-selected")).toBe("true");
      }
      const popup = page.waitForEvent("popup");
      await option.click({ modifiers: ["Control"] });
      const tab = await popup;
      await tab.waitForURL("**/admin");
      await tab.close();
      await input.fill("utilities");
      await waitForRows(page, 1);
      expect(await option.innerText()).toContain(lang === "de" ? "Werkzeuge" : "Tools");
      expect(await option.locator("small").innerText()).toBe("App");
      expect(searches).toHaveLength(0);
      await input.press("Enter");
      await page.waitForURL("**/tools");
    } finally {
      await view.close();
    }
  });
  test(`app launcher opens the selected admin app by click (${lang})`, async () => {
    const admin = await open(views[0]!, `/?launcher&public&admin&lang=${lang}&q=admin`);
    try {
      await waitForRows(admin.page, 1);
      await admin.page.getByRole("option").click();
      await admin.page.waitForURL("**/admin");
    } finally {
      await admin.close();
    }
  });
  test(`app launcher hides admin from public discovery and accepts a fuzzy alias (${lang})`, async () => {
    const publicView = await open(views[1]!, `/?launcher&public&lang=${lang}&q=admin`);
    try {
      await publicView.page
        .getByText(lang === "de" ? "Keine Treffer. Versuche einen anderen Suchbegriff." : "No matches. Try another search term.")
        .waitFor();
      expect(await publicView.page.getByRole("option").count()).toBe(0);
      await publicView.page.locator('input[role="combobox"]').fill("werkzege");
      await waitForRows(publicView.page, 1);
      await publicView.page.keyboard.press("Escape");
      await publicView.page.locator("dialog").waitFor({ state: "detached" });
    } finally {
      await publicView.close();
    }
  });
}

test("launcher and chosen resources keep their positions and selection while providers stream", async () => {
  const first = gate();
  const second = gate();
  answer = async (_url, write) => {
    write({ type: "start", query: "utilities", apps, providers: ["mail", "files"] });
    await first.opened;
    write(line("mail", [result("mail", "Utilities invoice", "Invented mail content")]));
    await second.opened;
    write(line("files", [result("files", "Utilities guide", "Invented file content")]));
  };
  const view = await open(views[0]!, "/?launcher&q=utilities");
  try {
    await waitForRows(view.page, 1);
    const launcher = view.page.getByRole("option").first();
    const before = await launcher.boundingBox();
    expect(await launcher.getAttribute("aria-selected")).toBe("true");
    first.open();
    await waitForRows(view.page, 2);
    expect(await launcher.boundingBox()).toEqual(before);
    expect(await launcher.getAttribute("aria-selected")).toBe("true");
    await view.page.keyboard.press("ArrowDown");
    const resource = view.page.getByRole("option").nth(1);
    await view.page.getByRole("option", { selected: true }).filter({ hasText: "Utilities invoice" }).waitFor();
    const resourceBefore = await resource.boundingBox();
    second.open();
    await waitForRows(view.page, 3);
    expect(await resource.boundingBox()).toEqual(resourceBefore);
    expect(await resource.getAttribute("aria-selected")).toBe("true");
    expect(await resource.innerText()).toContain("Utilities invoice");
    await view.page.keyboard.press("Enter");
    await view.page.waitForURL("**/app/mail");
  } finally {
    first.open();
    second.open();
    await view.close();
  }
});
