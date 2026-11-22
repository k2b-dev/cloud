// Spike check: SSR markup, island mount, ui-sdk Dialog/Menu/Combobox, layoutProblems({ flat: true }), screenshots.
// Usage: bun test/e2e.ts [chromium|webkit] [--shots]   (one browser, one server; both are stopped at the end)
import { type Page, chromium, webkit } from "playwright";
import { layoutProblems } from "../../../packages/ui/src/v2/layout-check";

const engineName = process.argv[2] === "webkit" ? "webkit" : "chromium";
const engine = engineName === "webkit" ? webkit : chromium;
const shots = process.argv.includes("--shots");
const root = `${import.meta.dir}/..`;
const port = 4400 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${engineName} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

const server = Bun.spawn(["bun", "--conditions=solid", "--preload=./scripts/preload.ts", "src/server.tsx"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: process.env.DEMO_MODE ?? "production", PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});

const settle = async (page: Page) => {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
};

const flat = (page: Page) => page.evaluate(layoutProblems, { root: ".k2-shell", flat: true });

try {
  for (let i = 0; i < 200; i++) {
    if (await fetch(`${base}/mail`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  // Server HTML: the page is complete without JavaScript.
  const html = await (await fetch(`${base}/mail?id=m1`)).text();
  check("SSR renders list, detail and island markup", html.includes("Angebot Eichenplatten") && html.includes('data-slot="dialog-trigger"') && html.includes('data-slot="menu-trigger"'));

  const browser = await engine.launch();
  const errors: string[] = [];
  const open = async (path: string, width: number, height = 900) => {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: "light" });
    page.on("pageerror", (error) => errors.push(`${path}@${width}: ${error.message}`));
    page.on("console", (message) => message.type() === "error" && errors.push(`${path}@${width}: ${message.text()}`));
    await page.goto(`${base}${path}`);
    await settle(page);
    return page;
  };

  const views: [string, string, number, number?][] = [
    ["inbox-detail", "/mail?id=m1", 1440],
    ["problem-detail", "/mail?id=m6", 1440],
    ["inbox-wide", "/mail?id=m1", 1920, 1080],
    // The tablet drawer lies over the list; the check does not see what a floating layer covers, so it runs on the list.
    ["tablet", "/mail", 834],
    ["tablet-drawer", "/mail?id=m1", 834],
    ["phone-list", "/mail", 390, 844],
    ["phone-detail", "/mail?id=m6", 390, 844],
  ];
  for (const [name, path, width, height] of views) {
    const page = await open(path, width, height);
    if (name !== "tablet-drawer") {
      const found = await flat(page);
      check(`layoutProblems flat clean: ${name} ${width}`, found.problems.length === 0, found.problems.slice(0, 12));
    }
    if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-${name}-${width}.png`, fullPage: width < 768 });
    await page.close();
  }

  // Hydration: islands adopt their server nodes. A client render would empty each wrapper and insert new nodes.
  {
    const probe = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    probe.on("pageerror", (error) => errors.push(`hydration probe: ${error.message}`));
    probe.on("console", (message) => message.type() === "error" && errors.push(`hydration probe: ${message.text()}`));
    await probe.addInitScript(() => {
      const state = { removed: 0 };
      Object.assign(window, { __hydration: state });
      new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target instanceof Element ? record.target : record.target.parentElement;
          if (target?.closest("solid-island")) state.removed += [...record.removedNodes].filter((node) => node.nodeType === 1).length;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await probe.goto(`${base}/mail?id=m1`);
    await settle(probe);
    const result = await probe.evaluate(() => ({
      islands: document.querySelectorAll("solid-island").length,
      hydrated: document.querySelectorAll("solid-island[data-hydrated]").length,
      removed: (window as unknown as { __hydration: { removed: number } }).__hydration.removed,
      triggerId: document.querySelector('[data-slot="dialog-trigger"]')?.id,
    }));
    check("Islands hydrate their server markup (no node replaced)", result.islands > 0 && result.hydrated === result.islands && result.removed === 0, result);
    check("ui-sdk ids from createUniqueId match the server", result.triggerId?.startsWith("ui-sdk-i") === true, result.triggerId);
    await probe.close();
  }

  // Islands: dialog with combobox, validation notice, menu.
  const page = await open("/mail?id=m1", 1440);
  await page.getByRole("button", { name: "Neue Nachricht" }).click();
  const dialog = page.getByRole("dialog", { name: "Neue Nachricht" });
  await dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  check("Dialog opens (ui-sdk) after island mount", await dialog.isVisible());
  check("Dialog moves focus inside", await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))));
  await dialog.getByRole("button", { name: "Senden" }).click();
  check("Sending without recipient shows the notice cell", await dialog.getByText("Empfänger fehlt").isVisible());
  if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-dialog-notice-1440.png` });
  const input = dialog.getByRole("combobox", { name: "An" });
  await input.click();
  await input.fill("Holz");
  const option = page.getByRole("option", { name: /Holzwerk Brandt/ });
  await option.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  check("Combobox filters to the matching contact", (await option.isVisible()) && !(await page.getByRole("option", { name: /Jonas/ }).isVisible()));
  if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-combobox-1440.png` });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check("Combobox selects with the keyboard", (await input.inputValue()) === "Holzwerk Brandt", await input.inputValue());
  await dialog.getByRole("button", { name: "Senden" }).click();
  await page.waitForTimeout(200);
  check("Sending closes the dialog and reports it", !(await dialog.isVisible()) && (await page.getByTestId("sent").textContent())?.includes("Holzwerk Brandt") === true);
  check("Focus returns to the trigger", await page.evaluate(() => document.activeElement?.textContent?.includes("Neue Nachricht") ?? false));
  await page.keyboard.press("Escape");

  const menuButton = page.getByRole("button", { name: /Aktionen für/ });
  await menuButton.click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  check("Menu opens (ui-sdk)", await menu.isVisible());
  if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-menu-1440.png` });
  // A menu opened by pointer highlights nothing; three steps down reach the third item.
  for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  check("Menu runs the chosen action by keyboard", (await page.getByTestId("menu-action").textContent()) === "archive", await page.getByTestId("menu-action").textContent());
  check("Menu closes after the action", !(await menu.isVisible()));

  // Overlay scrollbar: the list scrolls, its lines still reach the column edge.
  const edge = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-region=main] .k2-scroll")!;
    scroller.scrollTop = 200;
    const column = scroller.closest(".k2-col")!.getBoundingClientRect();
    const row = scroller.querySelector(".k2-row")!.getBoundingClientRect();
    return { overflow: scroller.scrollHeight > scroller.clientHeight, gap: column.right - row.right };
  });
  check("List overflows and rows reach the column edge (no gutter)", edge.overflow && Math.abs(edge.gap) <= 1, edge);
  check("No page errors", errors.length === 0, errors);
  await browser.close();
} finally {
  server.kill();
  await server.exited;
}
const failed = results.filter((result) => !result.ok).length;
console.log(`${engineName}: ${results.length - failed}/${results.length} ok`);
process.exit(failed ? 1 : 0);
