import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Route } from "playwright";
import { launchHookMs, settled } from "../../../../../../ui/test/browser";
import { createScreenBrowser, phone, type View, wide } from "../../../../../test/v2-screen-browser";
import { spaceOpener } from "./space-screen.browser-open";
import { itemDetail, spaceScreenProps } from "./space-screen.fixture";

// A video attached to a task plays in the shared Lightbox of the v2 detail, as on main (v1's item-detail browser
// suite): its row shows a decoded first frame, the player takes the focus, the whole reel stays in view, the content
// route is read in ranges, and a video the browser cannot play says so without dropping the focus to the page.
const screen = createScreenBrowser(resolve(import.meta.dir, "space-screen.browser-harness.tsx"));
beforeAll(screen.start, launchHookMs);
afterAll(screen.stop);
const open = spaceOpener(screen);

const media: Record<string, { bytes: Uint8Array<ArrayBuffer>; type: string }> = {
  Reel01: {
    bytes: new Uint8Array(readFileSync(resolve(import.meta.dir, "../../../../../../ui/test/media/portrait-180x320.webm"))),
    type: "video/webm",
  },
  Broken: { bytes: new TextEncoder().encode("This is no video at all."), type: "video/quicktime" },
};
const attachment = (id: string, filename: string) => ({
  id,
  filename,
  mimeType: media[id]!.type,
  sizeBytes: media[id]!.bytes.length,
  kind: "file" as const,
  createdAt: "2026-10-14T10:00:00.000Z",
});
const reel = attachment("Reel01", "Reel for approval.webm");
const broken = attachment("Broken", "Broken.mov");

/** The detail of "Clear out shelf B" with the attachments, and the content route with ranges, as the server serves it. */
const serving = (attachments: ReturnType<typeof attachment>[]) => {
  const ranges: (string | null)[] = [];
  const api = (url: URL, route: Route) => {
    if (url.pathname === "/api/spaces/Space1/items/Item01/detail") {
      const item = spaceScreenProps("/app/spaces/Space1").state.itemsResult.items.find((entry) => entry.id === "Item01")!;
      return { ...itemDetail(item), attachments };
    }
    const content = url.pathname.match(/^\/api\/spaces\/Space1\/items\/Item01\/attachments\/(\w+)\/content$/);
    const file = content && media[content[1]!];
    if (!file) return undefined;
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    ranges.push(range?.[0] ?? null);
    const headers = { "content-type": file.type, "accept-ranges": "bytes" };
    if (!range) return new Response(file.bytes, { headers });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : file.bytes.length - 1, file.bytes.length - 1);
    return new Response(file.bytes.subarray(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${file.bytes.length}` },
    });
  };
  return { api, ranges };
};

describe("videos of a task on v2", () => {
  for (const view of [wide, phone] as View[])
    test(`${view.name}: a video attachment shows its first frame and plays in the Lightbox, the whole reel in view`, async () => {
      const server = serving([reel]);
      const { context, tab, errors } = await open(view, "/app/spaces/Space1?view=list&groupBy=none", "usual", { api: server.api });
      try {
        await tab.locator('a[href*="item=Item01"]').first().click();
        const detail = tab.locator('[data-k2-part="Pane"][data-detail]');
        const tile = detail.getByRole("button", { name: "Reel for approval.webm", exact: true });
        await tile.scrollIntoViewIfNeeded();
        // The row shows a decoded frame, not only the video's size and length.
        await tab.waitForFunction(
          () => (document.querySelector('[data-k2-part="Pane"][data-detail] video') as HTMLVideoElement | null)?.readyState! >= 2,
        );
        const row = tile.locator("xpath=ancestor::*[contains(@class, 'k2b-file-grid__item')][1]");
        expect(await row.locator(".k2b-file-grid__meta").textContent()).toMatch(/^Video · /);

        await tile.click();
        await tab.waitForSelector("dialog.k2b-lightbox[open] .k2b-video-player__video");
        await tab.waitForFunction(() => (document.querySelector(".k2b-lightbox video") as HTMLVideoElement).readyState >= 1);
        // The player has the focus, so Space and the arrows work in the video at once.
        await tab.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Reel for approval.webm");
        const stage = (await tab.locator(".k2b-lightbox__stage").boundingBox())!;
        const frame = (await tab.locator(".k2b-lightbox .k2b-video-player").boundingBox())!;
        expect(frame.y).toBeGreaterThanOrEqual(stage.y);
        expect(frame.y + frame.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
        if (view === phone) {
          const dialog = (await tab.locator("dialog.k2b-lightbox").boundingBox())!;
          expect([dialog.x, dialog.y, dialog.width, dialog.height]).toEqual([0, 0, phone.width, phone.height]);
        }
        expect(await tab.locator(".k2b-lightbox__actions a[download]").getAttribute("href")).toBe(
          "/api/spaces/Space1/items/Item01/attachments/Reel01/content?download=true",
        );
        expect(server.ranges.some((range) => range !== null)).toBe(true);
        // The reel plays: play() resolves once it does. Muted, it needs no gesture.
        await tab.$eval(".k2b-lightbox video", (element) => {
          const video = element as HTMLVideoElement;
          video.muted = true;
          return video.play();
        });
        await tab.keyboard.press("Escape");
        await tab.waitForSelector("dialog.k2b-lightbox", { state: "detached" });
        await settled(tab);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  test("a video the browser cannot play says so and keeps the focus in the Lightbox", async () => {
    const server = serving([broken]);
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list&groupBy=none", "usual", { api: server.api });
    try {
      await tab.locator('a[href*="item=Item01"]').first().click();
      await tab.locator('[data-k2-part="Pane"][data-detail]').getByRole("button", { name: "Broken.mov", exact: true }).click();
      await tab.waitForSelector(".k2b-lightbox .k2b-video-player__fallback[role=alert]");
      expect(await tab.locator(".k2b-lightbox .k2b-video-player__fallback").innerText()).toContain("This video cannot play here");
      // The focus started on the video, which the fallback replaced; it stays in the Lightbox.
      expect(await tab.evaluate(() => document.querySelector("dialog.k2b-lightbox")!.contains(document.activeElement))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
