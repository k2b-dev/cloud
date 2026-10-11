import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { emailDesignPreviewDocument } from "./email-design-preview-document";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
/** Image paths that reached the server; Chromium reports a request even when the policy blocks it. */
const requested = new Set<string>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith(".png")) {
      requested.add(pathname);
      return new Response(PNG, { headers: { "Content-Type": "image/png" } });
    }
    return new Response("<!doctype html><html><body></body></html>", { headers: { "Content-Type": "text/html" } });
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const text = { heading: "Heading", greeting: "Hello", body: "Body", quote: "Quote", closing: "Regards", team: "Team" };
const design = (path: string) =>
  emailDesignPreviewDocument(`.mail-content { background-image: url("${server.url.origin}${path}"); }`, text);

describe("email design preview", () => {
  test("styles the sample message but loads nothing the CSS names", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(server.url.href);
    // The same page without its policy fetches the image, so this setup notices a load.
    const withoutPolicy = design("/without-policy.png").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    expect(withoutPolicy).not.toContain("Content-Security-Policy");
    // A frame fires load only after the images its CSS uses have loaded or failed.
    await page.evaluate(
      (documents) =>
        Promise.all(
          documents.map(
            (source) =>
              new Promise<void>((resolve) => {
                const frame = document.createElement("iframe");
                frame.setAttribute("sandbox", "");
                frame.addEventListener("load", () => resolve(), { once: true });
                frame.srcdoc = source;
                document.body.append(frame);
              }),
          ),
        ),
      [withoutPolicy, design("/preview.png")],
    );
    expect(requested.has("/without-policy.png")).toBe(true);
    expect(requested.has("/preview.png")).toBe(false);
    const heading = await page
      .frameLocator("iframe >> nth=1")
      .locator("h1")
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(heading).toBe("22px");
  });
});
