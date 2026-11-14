import { launchBrowser, settled } from "../../../ui/test/browser";
import { startGallery } from "./zz-composer-gallery.fixture";
const out = "/tmp/claude-1000/-home-valentinkolb--t3-worktrees-cloud-t3-31aae2a9-0ae0a44a7905ecaa/5b844639-b1b2-40b9-b9c5-c787a7423607/scratchpad/gallery";
const server = await startGallery();
const browser = await launchBrowser();
try {
  for (const width of [1440, 390]) {
    for (const state of ["rest", "focus", "suggestion", "typed", "running", "usage", "nomodel"]) {
      const page = await browser.newPage({ viewport: { width, height: 400 } });
      await page.goto(`${server.url}?state=${state}`);
      await page.locator("#cell .k2b-chat-composer").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(1, 1);
      if (state === "focus" || state === "typed") await page.locator("#cell textarea:not(.k2b-chat-composer__measure)").focus();
      await settled(page);
      const box = (await page.locator("#cell").boundingBox())!;
      await page.screenshot({ path: `${out}/${width}-${state}.png`, clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 } });
      const m = await page.evaluate(() => {
        const c = document.querySelector("#cell .k2b-chat-composer")!;
        const s = getComputedStyle(c);
        return { w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height, r: s.borderTopLeftRadius, b: s.borderTopWidth, col: s.borderTopColor };
      });
      console.log(width, state, JSON.stringify(m));
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
