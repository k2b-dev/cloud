import { afterAll, describe, expect, test } from "bun:test";
import { chromium, type Frame, type Page } from "playwright";
import type {} from "./MailMessageBody.browser-harness";

// A 1x1 PNG; natural width 1 proves the frame decoded delivered image bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const remoteIds = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
const failingId = remoteIds[5]!;
const html = [
  "<p>Hello</p>",
  ...remoteIds.map((id, index) => `<p>Remote ${index}</p><img alt="remote-${index}" data-mail-remote-image="${id}">`),
  '<img alt="cid-0" src="cid:Logo%40Example.com"><img alt="cid-1" src="cid:banner@example.com">',
].join("");

const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailMessageBody.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-message-body-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail message body harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const imageHeaders = {
  "Content-Type": "image/png",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript" } });
    if (pathname.startsWith("/api/mail/mailboxes/Box001/messages/Msg001/remote-images/")) {
      return pathname.endsWith(failingId) ? new Response("Upstream failed", { status: 502 }) : new Response(PNG, { headers: imageHeaders });
    }
    if (pathname.startsWith("/api/mail/mailboxes/Box001/messages/Msg001/attachments/")) return new Response(PNG, { headers: imageHeaders });
    return new Response('<!doctype html><html><body><div id="root"></div><script src="/harness.js"></script></body></html>', {
      headers: { "Content-Type": "text/html" },
    });
  },
});

afterAll(() => server.stop(true));

type OpenedMessage = { page: Page; frame: Frame; errors: string[] };

const withOpenedMessage = async (allowedByRule: boolean, run: (message: OpenedMessage) => Promise<void>): Promise<void> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("502")) errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.evaluate(
      ({ html, remoteIds, allowedByRule }) =>
        window.mountMailMessageBody({
          mailboxId: "Box001",
          messageId: "Msg001",
          format: "html",
          html,
          plainText: null,
          attachments: [
            { id: "Att001", contentId: "<logo@example.com>", contentType: "image/png", sizeBytes: 100 },
            { id: "Att002", contentId: "<Banner@example.com>", contentType: "image/png", sizeBytes: 100 },
          ],
          remoteContent: { imageIds: remoteIds, allowedByRule, sender: "sender@example.com", domain: "example.com" },
        }),
      { html, remoteIds, allowedByRule },
    );
    const frame = await (await page.waitForSelector("iframe")).contentFrame();
    if (!frame) throw new Error("Message frame did not load");
    await run({ page, frame, errors });
  } finally {
    await browser.close();
  }
};

const visibleImages = (frame: Frame, count: number) =>
  frame.waitForFunction(
    (count) => Array.from(document.images).filter((image) => image.complete && image.naturalWidth > 0).length === count,
    count,
  );

const imageStates = (frame: Frame) =>
  frame.evaluate(() => Object.fromEntries(Array.from(document.images).map((image) => [image.alt, image.naturalWidth > 0])));

describe("HTML mail message frame", () => {
  test("shows allowed remote and inline images without reloading the frame", async () => {
    await withOpenedMessage(true, async ({ page, frame, errors }) => {
      await visibleImages(frame, 7);
      // The failed image keeps the notice; wait until every remote request settled.
      await page.waitForSelector('button:has-text("Load images"):not([disabled])');
      const trace = await page.evaluate(() => window.mailMessageBodyTrace);

      expect(await imageStates(frame)).toEqual({
        "remote-0": true,
        "remote-1": true,
        "remote-2": true,
        "remote-3": true,
        "remote-4": true,
        "remote-5": false,
        "cid-0": true,
        "cid-1": true,
      });
      expect(trace.loads).toHaveLength(1);
      expect(trace.srcdocChanges).toBe(0);
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("keeps the frame document when blocked remote images are loaded on request", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);
      expect(await frame.evaluate(() => document.querySelectorAll("img[src]").length)).toBe(2);

      await page.getByRole("button", { name: "Load images" }).click();
      await visibleImages(frame, 7);
      await page.waitForSelector('button:has-text("Load images"):not([disabled])');
      const trace = await page.evaluate(() => window.mailMessageBodyTrace);

      expect((await imageStates(frame))["remote-5"]).toBeFalse();
      expect(trace.loads).toHaveLength(1);
      expect(trace.srcdocChanges).toBe(0);
      expect(errors).toEqual([]);
    });
  }, 30_000);
});
