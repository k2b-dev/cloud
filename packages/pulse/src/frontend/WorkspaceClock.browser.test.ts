import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { pauseWorkspaceClock } from "./PulseWorkspace.browser-fixture";

let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

test("a delayed clock pause preserves fixture time and later timer advancement", async () => {
  const tab = await browser.newPage();
  const time = new Date("2026-10-20T14:32:00Z");
  const clock = tab.clock;
  const pause = clock.pauseAt.bind(clock);
  const delayedPause = spyOn(clock, "pauseAt").mockImplementation(async (target) => {
    // Deterministically model elapsed time between installing and pausing the clock.
    await clock.runFor(1_000);
    await pause(target);
  });
  try {
    await pauseWorkspaceClock(clock, time);
    // real clock: Assert the browser’s mocked Date against the fixed fixture.
    expect(await tab.evaluate(() => Date.now())).toBe(time.getTime());
    await tab.goto("data:text/html,<body>Clock fixture</body>");
    // real clock: Assert the browser’s mocked Date against the fixed fixture.
    expect(await tab.evaluate(() => Date.now())).toBe(time.getTime());
    await tab.evaluate(() => {
      setTimeout(() => {
        // real clock: Observe the mocked timer’s firing time after controlled advancement.
        document.body.dataset.fired = String(Date.now());
      }, 250);
    });
    await clock.runFor(250);
    expect(await tab.locator("body").getAttribute("data-fired")).toBe(String(time.getTime() + 250));
    // real clock: Assert the browser’s mocked Date against the fixed fixture.
    expect(await tab.evaluate(() => Date.now())).toBe(time.getTime() + 250);
  } finally {
    delayedPause.mockRestore();
    await tab.close();
  }
}, 30_000);
