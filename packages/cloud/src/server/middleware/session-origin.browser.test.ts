import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { sessionOriginGuard } from "./session-origin";

let browser: Browser;
let cloud: ReturnType<typeof Bun.serve>;
let foreign: ReturnType<typeof Bun.serve>;
let origin: string;
let writes = 0;
const socketRequests: Array<{ origin: string | null; cookie: string | null }> = [];
const received: Array<{ origin: string | undefined; site: string | undefined; cookie: string | undefined }> = [];

beforeAll(async () => {
  const routes = new Hono()
    .use(sessionOriginGuard(["/share/mail/attachments/:token"], async () => origin))
    .get(
      "/socket",
      upgradeWebSocket((c) => ({
        onOpen: (_event, socket) => {
          if (c.req.header("Cookie")) socket.send("connected");
          else socket.close(1008, "forbidden_origin");
        },
      })),
    )
    .get("/", (c) => c.html("<p>Cloud</p>", 200, { "Referrer-Policy": "same-origin" }))
    .get("/forms/:kind", (c) => {
      const kind = c.req.param("kind");
      const action =
        kind === "mail" ? "/share/mail/attachments/own-token" : kind === "jobs" ? "/admin/observability/jobs/run-now" : `/oauth/${kind}`;
      return c.html(`<form method="post" action="${action}"><input name="decision" value="approve"><button>Submit</button></form>`, 200, {
        "Referrer-Policy": "same-origin",
      });
    })
    .get("/pwa/example", (c) => c.html("<p>Phone</p>", 200, { "Referrer-Policy": "no-referrer" }))
    .post("*", (c) => {
      writes++;
      received.push({ origin: c.req.header("Origin"), site: c.req.header("Sec-Fetch-Site"), cookie: c.req.header("Cookie") });
      return c.text("Saved");
    });
  cloud = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket")
        socketRequests.push({ origin: request.headers.get("Origin"), cookie: request.headers.get("Cookie") });
      return routes.fetch(request, server);
    },
    websocket,
  });
  origin = `http://localhost:${cloud.port}`;
  foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        `<form method="post" action="${origin}/api/pulse/bases/base/clear-data"><input name="value" value="1"><button>Submit</button></form>`,
        { headers: { "Content-Type": "text/html" } },
      ),
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await cloud?.stop(true);
  await foreign?.stop(true);
});

test("native same-origin OAuth and job form posts and token-bound Mail unlock posts keep working", async () => {
  const context = await browser.newContext();
  try {
    await context.addCookies([{ name: "session_token", value: "web-fixture", url: origin, sameSite: "Lax", httpOnly: true }]);
    const page = await context.newPage();
    for (const kind of ["consent", "device", "jobs", "mail"]) {
      await page.goto(`${origin}/forms/${kind}`);
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST"),
        page.getByRole("button", { name: "Submit" }).click(),
      ]);
      expect(response.status()).toBe(200);
      expect(received.at(-1)?.origin).toBe(origin);
      expect(received.at(-1)?.site).toBe("same-origin");
      expect(received.at(-1)?.cookie).toBe(kind === "mail" ? undefined : "session_token=web-fixture");
    }
  } finally {
    await context.close();
  }
});

test("same-site foreign form, multipart, text/plain and bodyless POSTs cannot dispatch a write", async () => {
  const context = await browser.newContext();
  try {
    await context.addCookies([{ name: "session_token", value: "web-fixture", url: origin, sameSite: "Lax", httpOnly: true }]);
    const page = await context.newPage();
    for (const encoding of ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain", "bodyless"]) {
      await page.goto(`http://localhost:${foreign.port}`);
      await page.locator("form").evaluate((form, encoding) => {
        if (encoding === "bodyless") form.querySelector("input")?.remove();
        else form.setAttribute("enctype", encoding);
      }, encoding);
      const before = writes;
      const [rejected] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST"),
        page.getByRole("button", { name: "Submit" }).click(),
      ]);
      expect(rejected.status()).toBe(403);
      const headers = await rejected.request().allHeaders();
      expect(headers.origin).toBe(`http://localhost:${foreign.port}`);
      expect(headers["sec-fetch-site"]).toBe("same-site");
      expect(headers.cookie).toContain("session_token=web-fixture");
      expect(writes).toBe(before);
    }
  } finally {
    await context.close();
  }
});

for (const cookieName of ["session_token", "pwa_session"])
  test(`${cookieName} fetch mutations keep their Origin even on no-referrer mobile pages`, async () => {
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: cookieName, value: "app-fixture", url: origin, sameSite: "Lax", httpOnly: true }]);
      const page = await context.newPage();
      await page.goto(`${origin}/pwa/example`);
      const statuses = await page.evaluate(async () => {
        const upload = new FormData();
        upload.set("file", new Blob(["hello"]), "example.txt");
        const values = [];
        for (const body of [undefined, '{"value":1}', upload]) {
          values.push((await fetch("/api/example/write", { method: "POST", body })).status);
        }
        return values;
      });
      expect(statuses).toEqual([200, 200, 200]);
      // Web Vitals uses a JSON Blob beacon, which selects cors mode too.
      const [beacon] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/me/web-vitals")),
        page.evaluate(() => navigator.sendBeacon("/api/me/web-vitals", new Blob(['{"value":1}'], { type: "application/json" }))),
      ]);
      expect(beacon.status()).toBe(200);
      expect(received.at(-1)?.origin).toBe(origin);
      expect(received.at(-1)?.cookie).toBe(`${cookieName}=app-fixture`);
    } finally {
      await context.close();
    }
  });

for (const cookieName of ["session_token", "pwa_session"])
  test(`${cookieName}: native websocket upgrades accept Cloud and close a same-site sibling with 1008`, async () => {
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: cookieName, value: "socket-fixture", url: origin, sameSite: "Lax", httpOnly: true }]);
      const page = await context.newPage();
      const cases = [
        [origin, "connected"],
        [`http://localhost:${foreign.port}`, "rejected"],
      ] as const;
      for (const [pageOrigin, expected] of cases) {
        await page.goto(pageOrigin);
        const result = await page.evaluate(
          (target) =>
            new Promise<string>((resolve) => {
              const socket = new WebSocket(target);
              socket.onmessage = () => {
                socket.close();
                resolve("connected");
              };
              socket.onclose = (event) => resolve(event.code === 1008 ? "rejected" : `closed:${event.code}`);
              socket.onerror = () => {
                socket.close();
                resolve("handshake-error");
              };
            }),
          `${origin.replace("http:", "ws:")}/socket`,
        );
        expect(result).toBe(expected);
        expect(socketRequests.at(-1)).toEqual({ origin: pageOrigin, cookie: `${cookieName}=socket-fixture` });
      }
    } finally {
      await context.close();
    }
  });
