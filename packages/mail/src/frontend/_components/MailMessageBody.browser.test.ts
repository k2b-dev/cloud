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
  // Quoted history inside a dark cell: the toggle must follow the cell's text color.
  '<table><tr><td style="background: #18181b; color: #fafafa"><blockquote type="cite"><p>Earlier message</p></blockquote></td></tr></table>',
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

// The host's messages reach the frame in order. Reopening the quote through the
// same channel and seeing its toggle come back proves every earlier message ran.
const settleFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const target = document.querySelector("iframe")!.contentWindow!;
        const listener = (event: MessageEvent) => {
          if (event.source !== target || event.data?.type !== "quote") return;
          removeEventListener("message", listener);
          resolve();
        };
        addEventListener("message", listener);
        target.postMessage({ source: "cloud-mail-host", channel: "mail-message-Msg001", type: "quotes", value: [0] }, "*");
      }),
  );

const imageStates = (frame: Frame) =>
  frame.evaluate(() => Object.fromEntries(Array.from(document.images).map((image) => [image.alt, image.naturalWidth > 0])));

describe("HTML mail message frame", () => {
  test("toggles quoted text with a chevron that keeps the toggle in place", async () => {
    await withOpenedMessage(false, async ({ frame, errors }) => {
      const summary = frame.locator("details.mail-quoted-history > summary");
      const state = () =>
        summary.evaluate((element) => {
          const visible = [...element.querySelectorAll(".mail-quoted-labels > span")].filter(
            (label) => getComputedStyle(label).visibility === "visible",
          );
          const box = element.getBoundingClientRect();
          return {
            open: (element.parentElement as HTMLDetailsElement).open,
            display: getComputedStyle(element).display,
            chevron: getComputedStyle(element.querySelector("svg")!).transform,
            label: visible.map((label) => label.textContent).join(""),
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
          };
        });

      const closed = await state();
      expect(closed).toMatchObject({ open: false, display: "inline-flex", chevron: "none", label: "Show quoted text" });

      await summary.click();
      const opened = await state();
      expect(opened).toMatchObject({ open: true, label: "Hide quoted text" });
      expect(opened.chevron).not.toBe("none");
      expect(opened.box).toEqual(closed.box);
      expect(await frame.getByText("Earlier message").isVisible()).toBeTrue();
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("draws the quote toggle in the text color around it", async () => {
    await withOpenedMessage(false, async ({ frame }) => {
      const summary = frame.locator("details.mail-quoted-history > summary");
      const colors = () =>
        summary.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "color-mix(in srgb, #fafafa 65%, transparent)";
          element.parentElement!.append(probe);
          const dimmed = getComputedStyle(probe).color;
          probe.remove();
          return { toggle: getComputedStyle(element).color, dimmed };
        });

      const resting = await colors();
      expect(resting.toggle).toBe(resting.dimmed);
      await summary.hover();
      await frame.waitForFunction(
        () => getComputedStyle(document.querySelector("details.mail-quoted-history > summary")!).color === "rgb(250, 250, 250)",
      );
    });
  }, 30_000);

  test("keeps opened quoted text open when the frame document reloads", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);
      await frame.locator("details.mail-quoted-history > summary").click();
      await page.waitForFunction(() => window.mailMessageBodyTrace.quoteToggles === 1);

      // Solid's list reconciliation can move a message article; a moved frame reloads its document.
      await page.evaluate(() => {
        const root = document.getElementById("root")!;
        root.append(root.firstElementChild!);
      });
      await page.waitForFunction(() => window.mailMessageBodyTrace.loads.length === 2);
      const reloaded = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await reloaded.waitForFunction(() => document.querySelector<HTMLDetailsElement>("details.mail-quoted-history")?.open === true);
      await visibleImages(reloaded, 2);
      expect(await reloaded.getByText("Earlier message").isVisible()).toBeTrue();
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("follows a changed security verdict on the mounted message", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);

      await page.evaluate(() => window.updateMailMessageBody({ linksDisabled: true }));
      await page.waitForFunction(() => window.mailMessageBodyTrace.loads.length === 2);
      const quarantined = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await settleFrame(page);
      expect(await quarantined.evaluate(() => document.querySelectorAll("img[src]").length)).toBe(0);
      expect(await page.getByRole("button", { name: "Load images" }).count()).toBe(0);

      await page.evaluate(() => window.updateMailMessageBody({ linksDisabled: false }));
      await page.waitForFunction(() => window.mailMessageBodyTrace.loads.length === 3);
      const cleared = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await visibleImages(cleared, 2);
      expect(errors).toEqual([]);
    });
  }, 30_000);

  test("loads remote images once a sender rule arrives as a live update", async () => {
    await withOpenedMessage(false, async ({ page, frame, errors }) => {
      await visibleImages(frame, 2);
      await page.evaluate(
        (remoteIds) =>
          window.updateMailMessageBody({
            remoteContent: { imageIds: remoteIds, allowedByRule: true, sender: "sender@example.com", domain: "example.com" },
          }),
        remoteIds,
      );
      await visibleImages(frame, 7);
      expect((await page.evaluate(() => window.mailMessageBodyTrace)).loads).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  }, 30_000);

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
