import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import { iconStyles } from "../scripts/icons";

// The build inlines the icon subset as a data URL, which a busy device still decodes after the first frame. Here the
// same font comes from a URL that is held until that frame has been measured, so every run covers the late font.
const inlined = await iconStyles(`"ti ti-cloud" "ti ti-bell"`);
const font = /url\(data:font\/woff2;base64,([\w+/=]+)\)/.exec(inlined)!;
const page = `<!doctype html><html><head><meta charset="utf-8"><style>${inlined.replace(font[0], "url(/icons.woff2)")}</style></head>
<body style="margin:0;font:14px/1.5 sans-serif">
<div style="display:flex;align-items:center;gap:8px">
  <span style="display:inline-flex;align-items:center;gap:4px"><i class="ti ti-cloud"></i>Cloud</span>
  <button style="display:inline-flex;align-items:center;padding:4px;font-size:20px"><i class="ti ti-bell"></i></button>
  <span>after</span>
</div></body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("icons and the content after them keep their width until the icon font is decoded", async () => {
  const tab = await browser.newPage();
  const firstFrame = Promise.withResolvers<void>();
  try {
    await tab.route("http://pwa.test/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: page });
      if (pathname === "/icons.woff2") {
        await firstFrame.promise;
        return route.fulfill({ contentType: "font/woff2", body: Buffer.from(font[1]!, "base64") });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await tab.goto("http://pwa.test/", { waitUntil: "domcontentloaded" });
    const measure = () =>
      tab.evaluate(() => {
        const boxes = Array.from(document.body.querySelectorAll("*")).map((element) => {
          const { left, width } = element.getBoundingClientRect();
          return `${element.tagName.toLowerCase()}.${element.className} "${element.textContent?.trim()}" ${left} ${width}`;
        });
        const status: string[] = [];
        document.fonts.forEach((face) => {
          if (face.family === "tabler-icons") status.push(face.status);
        });
        return { boxes, status };
      });
    const before = await measure();
    firstFrame.resolve();
    await tab.evaluate(() => document.fonts.ready);
    const after = await measure();

    expect([before.status, after.status]).toEqual([["loading"], ["loaded"]]);
    expect(after.boxes.filter((box) => box.startsWith("i.ti ")).map((box) => box.split(" ").at(-1))).toEqual(["14", "20"]);
    expect(before.boxes).toEqual(after.boxes);
  } finally {
    firstFrame.resolve();
    await tab.close();
  }
}, 30_000);
