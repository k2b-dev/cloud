// Spike check for drag and drop on ui-sdk: sort the folders, drag a mail onto a folder; mouse, keyboard, touch (Chromium).
// Usage: bun test/dnd.ts [chromium|webkit] [--shots]   (one browser, one server; both are stopped at the end)
import { type Page, chromium, webkit } from "playwright";
import { layoutProblems } from "../../../packages/ui/src/v2/layout-check";

const engineName = process.argv[2] === "webkit" ? "webkit" : "chromium";
const engine = engineName === "webkit" ? webkit : chromium;
const shots = process.argv.includes("--shots");
const root = `${import.meta.dir}/..`;
const port = 4400 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${engineName} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

const server = Bun.spawn(["bun", "--conditions=solid", "--preload=./scripts/preload.ts", "src/server.tsx"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: process.env.DEMO_MODE ?? "production", PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});

const folderOrder = (page: Page) => page.$$eval(".k2-sortable__item", (items) => items.map((item) => item.textContent?.replace(/\d+$/, "").trim()));
const mailIds = (page: Page) => page.$$eval("[data-mail]", (rows) => rows.map((row) => (row as HTMLElement).dataset.mail));
const spoken = (page: Page) => page.$$eval("[aria-live]", (regions) => regions.map((region) => region.textContent ?? "").join(" | "));
// ui-sdk writes announcements a moment later (it batches one turn), so a check waits up to a second.
const heard = (page: Page, text: string) =>
  page.waitForFunction((t) => [...document.querySelectorAll("[aria-live]")].some((r) => r.textContent?.includes(t)), text, { timeout: 1000 }).then(() => true, () => false);
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
// Past the middle of an item: a sortable list places the moving item after an item once the pointer passes its middle.
const below = async (page: Page, selector: string) => {
  const point = await center(page, selector);
  return { x: point.x, y: point.y + 10 };
};
const mouseDrag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }, beforeDrop?: () => Promise<void>) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
  await page.waitForTimeout(80);
  await beforeDrop?.();
  await page.mouse.up();
  await page.waitForTimeout(120);
};

try {
  for (let i = 0; i < 200; i++) {
    if (await fetch(`${base}/dnd`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  const browser = await engine.launch();
  const errors: string[] = [];
  const open = async (width: number, height = 900, touch = false) => {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: "light", hasTouch: touch });
    page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`));
    page.on("console", (message) => message.type() === "error" && errors.push(`${width}: ${message.text()}`));
    await page.goto(`${base}/dnd`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    return page;
  };

  // Layout at rest.
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const page = await open(width, height);
    const found = await page.evaluate(layoutProblems, { root: ".k2-shell", flat: true });
    check(`layoutProblems flat clean: dnd ${width}`, found.problems.length === 0, found.problems.slice(0, 8));
    if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-dnd-${width}.png`, fullPage: width < 768 });
    await page.close();
  }

  const page = await open(1440);
  check("Board island hydrated", (await page.locator("solid-island[data-hydrated]").count()) === 1);
  const before = await folderOrder(page);

  // 1. Sort by mouse: the first folder goes below the third.
  await mouseDrag(page, await center(page, ".k2-sortable__item >> nth=0"), await below(page, ".k2-sortable__item >> nth=2"), async () => {
    check("Mouse sort: a dragged copy follows the pointer", (await page.locator("[data-drag-preview]").count()) === 1);
    if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-dnd-sort-mouse-1440.png` });
  });
  const afterMouse = await folderOrder(page);
  check("Mouse sort moves the folder", afterMouse[2] === before[0] && afterMouse.length === before.length, afterMouse);
  check("Mouse sort: the copy is gone after the drop", (await page.locator("[data-drag-preview]").count()) === 0);

  // 2. Sort by keyboard: Space lifts, two steps down, Space drops; focus stays on the item.
  await page.locator(".k2-sortable__item").first().focus();
  const lifted = (await folderOrder(page))[0];
  await page.keyboard.press("Space");
  check("Keyboard sort: pickup is announced in German", await heard(page, "aufgenommen"), await spoken(page));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  const afterKeys = await folderOrder(page);
  check("Keyboard sort moves the folder two places", afterKeys[2] === lifted, afterKeys);
  check("Keyboard sort: drop is announced", await heard(page, "abgelegt"), await spoken(page));
  check("Keyboard sort: focus stays on the moved item", await page.evaluate((name) => document.activeElement?.textContent?.includes(name ?? "") ?? false, lifted));

  // 3. Escape cancels a keyboard sort.
  const beforeEscape = await folderOrder(page);
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  check("Keyboard sort: Escape restores the order", JSON.stringify(await folderOrder(page)) === JSON.stringify(beforeEscape), await folderOrder(page));

  // 4. Drag a mail onto a folder with the mouse.
  const mails = await mailIds(page);
  await mouseDrag(page, await center(page, "[data-mail] >> nth=0"), await center(page, '[data-drop-target="archive"]'), async () => {
    check("Mail drag: the target under the pointer is marked", (await page.locator('[data-drop-target="archive"][data-over]').count()) === 1);
    check("Mail drag: the status line names the target", ((await page.getByTestId("board-status").textContent()) ?? "").includes("nach Archiv"));
    if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-dnd-mail-onto-folder-1440.png` });
  });
  check("Mail drag moves the mail out of the inbox", !(await mailIds(page)).includes(mails[0]), await mailIds(page));
  check("Mail drag: the folder counts it", ((await page.locator('[data-drop-target="archive"]').textContent()) ?? "").includes("1"));
  check("Mail drag: the move is announced", await heard(page, "verschoben nach Archiv"), await spoken(page));

  // 5. Letting go outside every folder changes nothing.
  const beforeMiss = await mailIds(page);
  await mouseDrag(page, await center(page, "[data-mail] >> nth=0"), { x: 900, y: 600 });
  check("Mail drag: release outside a folder changes nothing", JSON.stringify(await mailIds(page)) === JSON.stringify(beforeMiss));

  // 6. Keyboard: grip, Space, Down to the second folder, Enter.
  const second = (await page.$$eval("[data-drop-target]", (targets) => targets.map((target) => (target as HTMLElement).dataset.dropTarget)))[1];
  const moved = (await mailIds(page))[0];
  await page.locator("[data-mail] .k2-grip").first().focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(50);
  const marked = await page.$$eval("[data-drop-target][data-over]", (targets) => targets.map((target) => (target as HTMLElement).dataset.dropTarget));
  check("Keyboard drop: the chosen folder is marked", marked.length === 1 && marked[0] === second, { marked, second });
  if (shots) await page.screenshot({ path: `${root}/shots/${engineName}-dnd-keyboard-1440.png` });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
  check("Keyboard drop moves the mail", !(await mailIds(page)).includes(moved));
  check("Keyboard drop: focus moves to the next grip", await page.evaluate(() => document.activeElement?.classList.contains("k2-grip") ?? false));
  check("Keyboard drop: Escape cancels", await (async () => {
    const ids = await mailIds(page);
    await page.locator("[data-mail] .k2-grip").first().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    return JSON.stringify(await mailIds(page)) === JSON.stringify(ids) && (await heard(page, "Abgebrochen"));
  })());
  await page.close();

  // 7. Touch (Chromium: real touch events through CDP): a swipe scrolls, a hold then move drags.
  if (engineName === "chromium") {
    const touchPage = await open(1440, 900, true);
    const cdp = await touchPage.context().newCDPSession(touchPage);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const ids = await mailIds(touchPage);
    const from = await center(touchPage, "[data-mail] >> nth=0");
    const to = await center(touchPage, '[data-drop-target="invoices"]');
    // A quick swipe: no drag.
    await touch("touchStart", from.x, from.y);
    for (let step = 1; step <= 6; step++) await touch("touchMove", from.x, from.y - step * 12);
    await touch("touchEnd", from.x, from.y - 72);
    await touchPage.waitForTimeout(150);
    check("Touch: a swipe does not drag", JSON.stringify(await mailIds(touchPage)) === JSON.stringify(ids));
    // Hold, then move onto a folder.
    await touchPage.evaluate(() => document.querySelector(".k2-scroll")?.scrollTo(0, 0));
    await touch("touchStart", from.x, from.y);
    await touchPage.waitForTimeout(550);
    for (let step = 1; step <= 12; step++) await touch("touchMove", from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
    await touchPage.waitForTimeout(80);
    check("Touch: after the hold the target is marked", (await touchPage.locator('[data-drop-target="invoices"][data-over]').count()) === 1);
    await touch("touchEnd", to.x, to.y);
    await touchPage.waitForTimeout(150);
    check("Touch: hold and drag moves the mail", !(await mailIds(touchPage)).includes(ids[0]), await mailIds(touchPage));
    // Sorting by touch: ui-sdk starts after 3 px, without a hold (touch-action: none on the items).
    const order = await folderOrder(touchPage);
    const a = await center(touchPage, ".k2-sortable__item >> nth=0");
    const b = await below(touchPage, ".k2-sortable__item >> nth=2");
    await touch("touchStart", a.x, a.y);
    for (let step = 1; step <= 12; step++) await touch("touchMove", a.x, a.y + ((b.y - a.y) * step) / 12);
    await touch("touchEnd", b.x, b.y);
    await touchPage.waitForTimeout(150);
    check("Touch: folders sort by dragging", (await folderOrder(touchPage))[2] === order[0], await folderOrder(touchPage));
    await touchPage.close();
  }
  check("No page errors", errors.length === 0, errors);
  await browser.close();
} finally {
  server.kill();
  await server.exited;
}
const failed = results.filter((result) => !result.ok).length;
console.log(`${engineName}: ${results.length - failed}/${results.length} ok`);
process.exit(failed ? 1 : 0);
