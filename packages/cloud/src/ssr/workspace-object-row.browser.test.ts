import { describe, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { attach, installCompactShellHarness, open, phone } from "./compact-shell.browser-harness";

installCompactShellHarness(launchBrowser);

describe("phone object row", () => {
  for (const caller of ["mail", "contacts", "grids", "notebooks"]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${caller} ${theme}: objects precede the card in the server frame`, async () => {
        const { context, page } = await open(phone, `/app/mail/inbox?overview=1&objects=${caller}`, { theme, attached: false });
        try {
          const nav = page.locator("#overview-navigation");
          const head = page.locator(".k2b-app-workspace__head");
          const content = page.locator(".k2b-app-workspace__content");
          const navBox = (await nav.boundingBox())!;
          const cardBox = (await (caller === "mail" || caller === "contacts" ? head : content).boundingBox())!;
          expect(navBox.y + navBox.height).toBeLessThanOrEqual(cardBox.y);
          // The shell gradient must reach the objects. A transparent sidebar
          // alone would still leave them inside the old painted main card.
          const surfaces = await nav.evaluate((element) => {
            const result: string[] = [];
            for (let host: Element | null = element; host && !host.classList.contains("cloud-app-canvas"); host = host.parentElement)
              result.push(getComputedStyle(host).backgroundColor);
            return result;
          });
          expect(surfaces.every((color) => color === "rgba(0, 0, 0, 0)")).toBe(true);
          const shot = await page.screenshot();
          const paint = await page.evaluate(
            async ({ src, top }) => {
              const image = new Image();
              image.src = src;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(image, 0, 0);
              const pixel = (x: number, y: number) => [...ctx.getImageData(x, Math.round(y), 1, 1).data].slice(0, 3);
              return { corner: pixel(1, top + 4), card: pixel(195, top + 4) };
            },
            { src: `data:image/png;base64,${shot.toString("base64")}`, top: cardBox.y },
          );
          // The rounded corner exposes the shell; a full rectangular fill
          // would pass the transparent-ancestor check but erase this edge.
          expect(Math.max(...paint.corner.map((value, index) => Math.abs(value - paint.card[index]!)))).toBeGreaterThan(2);
          await attach(page);
          expect(await nav.boundingBox()).toEqual(navBox);
          expect(await (caller === "mail" || caller === "contacts" ? head : content).boundingBox()).toEqual(cardBox);
          const last = page.getByRole("button", { name: "Message 80", exact: true });
          await last.focus();
          const lastBox = (await last.boundingBox())!;
          const barBox = (await page.locator(".cloud-tab-bar").boundingBox())!;
          expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);
          expect(await page.locator(".k2b-app-workspace__main").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
          if (caller === "mail" || caller === "contacts") {
            const primary = page.getByRole("link", { name: "New object", exact: true });
            expect(
              await primary.evaluate((el) => {
                const box = el.getBoundingClientRect();
                return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
              }),
            ).toBe(true);
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  test("island-owned objects retain order through phone/tablet resizes", async () => {
    const { context, page } = await open(phone, "/app/mail/inbox?overview=1&objects=contacts&object-host=island");
    try {
      const nav = page.locator("#overview-navigation");
      const head = page.locator(".k2b-app-workspace__head");
      const original = await head.elementHandle();
      for (const width of [390, 834, 390]) {
        await page.setViewportSize({ width, height: phone.height });
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const navBox = (await nav.boundingBox())!;
        const headBox = (await head.boundingBox())!;
        if (width === 390) expect(navBox.y + navBox.height).toBeLessThanOrEqual(headBox.y);
        else expect(headBox.y + headBox.height).toBeLessThanOrEqual(navBox.y);
        expect(await original!.evaluate((el) => el === document.querySelector(".k2b-app-workspace__head"))).toBe(true);
        expect(await nav.locator("..").evaluate((el) => getComputedStyle(el).display)).toBe("contents");
      }
    } finally {
      await context.close();
    }
  });

  test("nested stacked objects do not replace the outer Cloud card", async () => {
    const { context, page } = await open(phone, "/app/mail/inbox?overview=1&objects=nested");
    try {
      expect(await page.locator(".layout-content-main").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("28px");
      expect(
        await page.locator(".k2b-app-workspace").evaluateAll((els) => els.map((el) => getComputedStyle(el, "::before").content)),
      ).toEqual(["none", "none"]);
      const nested = page.locator(".k2b-app-workspace .k2b-app-workspace");
      const nav = (await nested.locator(".k2b-app-workspace__sidebar").boundingBox())!;
      const head = (await nested.locator(".k2b-app-workspace__head").boundingBox())!;
      expect(head.y + head.height).toBeLessThanOrEqual(nav.y);
    } finally {
      await context.close();
    }
  });

  for (const width of [768, 834, 1440]) {
    test(`${width}px retains the tablet/desktop card`, async () => {
      const { context, page } = await open({ ...phone, width }, "/app/mail/inbox?overview=1&objects=contacts");
      try {
        expect(await page.locator(".k2b-app-workspace").evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
        if (width < 1024) {
          const head = (await page.locator(".k2b-app-workspace__head").boundingBox())!;
          const nav = (await page.locator("#overview-navigation").boundingBox())!;
          expect(head.y + head.height).toBeLessThanOrEqual(nav.y);
        }
      } finally {
        await context.close();
      }
    });
  }

  test("hidden or nonstacked navigation keeps the original phone card", async () => {
    for (const suffix of ["", "&objects=hidden"]) {
      const { context, page } = await open(phone, `/app/mail/inbox?overview=1${suffix}`);
      try {
        expect(await page.locator(".layout-content-main").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("28px");
        expect(await page.locator(".k2b-app-workspace").evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");
      } finally {
        await context.close();
      }
    }
  });
});
