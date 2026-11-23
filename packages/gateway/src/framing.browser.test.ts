import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import type { Browser } from "playwright";
import { useUnitClients } from "../../../scripts/fixtures/unit-clients";
import { launchBrowser, pageErrors } from "../../ui/test/browser";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { createGatewayHandler } from "./handler";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

// The framing default in a real engine: a Cloud page still frames another Cloud page, as the side panel does, while a
// page of another origin cannot frame one. Only an answer that states its own `frame-ancestors` decides otherwise.
useUnitClients();

const HTML = { "Content-Type": "text/html; charset=utf-8" };
/** A framed page reports to its parent as soon as its script runs; a refused frame never runs it. */
const panel = (id: string) =>
  `<!doctype html><title>${id}</title><body>${id}<script>parent.postMessage(${JSON.stringify(id)}, "*")</script></body>`;
/** A parent page that records framed pages' reports and every frame's load event. */
const host = (frames: string[]) =>
  `<!doctype html><title>Host</title><script>window.reports=[];window.loads=0;addEventListener("message",(e)=>reports.push(e.data))</script>${frames
    .map((src) => `<iframe src="${src}" onload="window.loads++"></iframe>`)
    .join("")}`;

const app = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    // The side panel loads a provider path of the same origin, the way panel-slot.ts builds it.
    if (path === "/app/host/") return new Response(host(["/app/notes/panel"]), { headers: HTML });
    if (path === "/app/notes/panel") return new Response(panel("panel"), { headers: HTML });
    // An app that deliberately allows every embedder keeps that decision.
    if (path === "/app/notes/embed")
      return new Response(panel("embed"), { headers: { ...HTML, "Content-Security-Policy": "frame-ancestors *" } });
    return new Response("Not found", { status: 404 });
  },
});
let snapshot: DomainSnapshot | undefined;
const handle = createGatewayHandler({
  snapshot: () => {
    if (!snapshot) throw new Error("Gateway snapshot is not ready");
    return snapshot;
  },
  table: () =>
    buildRouteTable([
      { prefix: "/app/host", appId: "host", baseUrl: app.url.href },
      { prefix: "/app/notes", appId: "notes", baseUrl: app.url.href },
    ]),
  stats: createProxyStats(),
  log: () => {},
  health: () => Response.json({ status: "ok" }),
  storage: async () => new Response(null, { status: 404 }),
});
const gateway = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req, server) =>
    (await handle(req, { upgrade: () => false, timeout: (r, s) => server.timeout(r, s) }, null)) ??
    new Response("No upgrade", { status: 400 }),
});
const cloud = `http://127.0.0.1:${gateway.port}`;
snapshot = { cloudHosts: cloudHostSet(cloud, [], false), domainsReady: true, domains: new Map(), apps: new Map(), development: false };
// Another port is another origin: the stand-in for a foreign site.
const foreign = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(host([`${cloud}/app/notes/panel`, `${cloud}/app/notes/embed`]), { headers: HTML }),
});

let browser: Browser;
const telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  telemetry.mockRestore();
  await browser?.close();
  for (const server of [foreign, gateway, app]) server.stop(true);
});

test("a Cloud page frames another Cloud page of the same origin, as the side panel does", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = pageErrors(page);
    const response = await page.goto(`${cloud}/app/host/`);
    expect(response?.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
    await page.waitForFunction(() => Reflect.get(window, "loads") === 1);
    expect(await page.evaluate(() => Reflect.get(window, "reports"))).toEqual(["panel"]);
    // Same origin: the host can still reach into the frame, which the panel runtime relies on.
    expect(await page.evaluate(() => document.querySelector("iframe")?.contentDocument?.title)).toBe("panel");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a page of another origin cannot frame a Cloud page; an app's own frame-ancestors still lets it", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${foreign.port}/`);
    // Both frames finished loading: the allowed one reported, the refused one never ran its script.
    await page.waitForFunction(() => Reflect.get(window, "loads") === 2 && Reflect.get(window, "reports").length > 0);
    expect(await page.evaluate(() => Reflect.get(window, "reports"))).toEqual(["embed"]);
  } finally {
    await context.close();
  }
});
