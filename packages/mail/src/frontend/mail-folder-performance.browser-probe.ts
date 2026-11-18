import { expect } from "bun:test";
import type { Page } from "playwright";

export async function measureFolderSwitches(page: Page) {
  // Regression ceiling for this shared-CPU fixture, not the product's 50 ms goal.
  // UI-build A/B: ten warm samples/side, candidate maximum 93 ms; allow scheduling
  // headroom here. The selector-AST test deterministically guards the actual cause.
  const longTaskBudgetMs = 150;
  const frames = () =>
    page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.getByRole("button", { name: "More", exact: true }).click();
  await frames();
  const requests: string[] = [];
  let sockets = 0;
  page.on("request", (request) => requests.push(`${request.resourceType()} ${new URL(request.url()).pathname}`));
  page.on("websocket", () => ++sockets);
  const measurements = [];
  for (let iteration = 0; iteration < 14; iteration++) {
    const folder = iteration % 2 ? "Inbox1" : "Archive1";
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accept = () => {};
    let rejectResponse: (error: unknown) => void = () => {};
    const accepted = new Promise<void>((resolve, reject) => {
      accept = resolve;
      rejectResponse = reject;
    });
    // Route errors may precede the awaited click; keep the rejection for the explicit await.
    void accepted.catch(() => {});
    let intercepted = false;
    let complete = () => {};
    const fulfilled = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await page.route("**/workspace-list?*", async (route) => {
      intercepted = true;
      try {
        const response = await route.fetch();
        accept();
        await held;
        await route.fulfill({ response });
      } catch (error) {
        rejectResponse(error);
        await route.abort().catch(() => {});
      } finally {
        complete();
      }
    });
    const target = page.locator(`.mail-sidebar a[href="/app/mail/Box001?folder=${folder}"]`).first();
    await target.hover();
    await frames();
    requests.length = 0;
    const probe = await page.evaluateHandle(() => {
      const before = new Set(document.querySelectorAll(".mail-list-entry"));
      const sidebar = document.querySelector(".mail-sidebar");
      const bounds = () => {
        const box = document.querySelector(".mail-list-scroll")?.getBoundingClientRect();
        return box && [box.x, box.y, box.width, box.height];
      };
      const oldBounds = bounds();
      const start = performance.now();
      const tasks: number[] = [];
      const collect = (entries: PerformanceEntry[]) =>
        tasks.push(...entries.filter((entry) => entry.startTime >= start).map((entry) => entry.duration));
      const observer = new PerformanceObserver((list) => collect(list.getEntries()));
      observer.observe({ type: "longtask" });
      let keyDispatchMs: number | null = null;
      const keydown = (event: KeyboardEvent) => {
        keyDispatchMs = performance.now() - event.timeStamp;
      };
      document.addEventListener("keydown", keydown, { once: true });
      return {
        pending() {
          const rows = [...document.querySelectorAll(".mail-list-entry")];
          return {
            retained: rows.length === 50 && rows.every((row) => before.has(row)),
            bounds: bounds(),
            oldBounds,
            busy: document.querySelector(".mail-main")?.getAttribute("aria-busy"),
          };
        },
        finish() {
          collect(observer.takeRecords());
          observer.disconnect();
          document.removeEventListener("keydown", keydown);
          const rows = [...document.querySelectorAll(".mail-list-entry")];
          return {
            tasks,
            keyDispatchMs,
            rows: rows.length,
            retainedRows: rows.filter((row) => before.has(row)).length,
            nodes: document.querySelectorAll("*").length,
            sidebarRetained: sidebar === document.querySelector(".mail-sidebar"),
          };
        },
      };
    });
    try {
      const requested = page.waitForRequest("**/workspace-list?*");
      await target.click();
      await requested;
      await accepted;
      await frames();
      const pending = await probe.evaluate((p) => p.pending());
      expect(pending.retained).toBe(true);
      expect(pending.bounds).toEqual(pending.oldBounds);
      expect(pending.busy).toBe("true");
      await page.locator("input").first().press("ArrowRight");
      release();
      await page.waitForURL((url) => url.searchParams.get("folder") === folder);
      await frames();
      const result = await probe.evaluate((p) => p.finish());
      measurements.push({ iteration, folder, ...result, requests: [...requests] });
      expect(result.rows).toBe(50);
      expect(result.retainedRows).toBe(0);
      expect(result.sidebarRetained).toBe(true);
      expect(result.nodes).toBeLessThan(2000);
      expect(requests).toEqual(["fetch /api/mail/mailboxes/Box001/workspace-list"]);
      expect(sockets).toBe(0);
    } finally {
      release();
      if (intercepted) await fulfilled;
      await probe.evaluate((p) => p.finish()).catch((error) => console.warn("Folder probe cleanup", error));
      await probe.dispose().catch((error) => console.warn("Folder probe dispose", error));
      await page.unroute("**/workspace-list?*");
    }
  }
  console.info(`MAIL_FOLDER_GUARD ${JSON.stringify(measurements)}`);
  // Discard four cold switches; keep ten warm switches, five in each direction.
  for (const result of measurements.slice(4)) {
    expect(Math.max(0, ...result.tasks), JSON.stringify(result)).toBeLessThanOrEqual(longTaskBudgetMs);
    expect(result.keyDispatchMs).not.toBeNull();
    expect(Number.isFinite(result.keyDispatchMs)).toBe(true);
  }
  await page.goBack();
  await page.waitForURL((url) => url.searchParams.get("folder") === "Archive1");
  await frames();
  const rows = await page.locator(".mail-list-entry").allTextContents();
  await page.reload();
  await page.locator('html[data-mail-shell-ready="true"]').waitFor();
  expect(new URL(page.url()).searchParams.get("folder")).toBe("Archive1");
  expect(await page.locator(".mail-list-entry").allTextContents()).toEqual(rows);
}
