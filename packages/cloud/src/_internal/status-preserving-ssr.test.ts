import { expect, test } from "bun:test";
import type { HtmlFn } from "@k2b/ssr";
import { Hono } from "hono";
import { createStatusPreservingSsrHandler } from "./status-preserving-ssr";

type Page = { title?: string };

const html: HtmlFn<Page> = async (render, page) =>
  new Response(`<title>${page?.title ?? ""}</title>${render()}`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Rendered": "yes" },
  });

const ssr = createStatusPreservingSsrHandler(html);

test("SSR render functions preserve status and headers set through Hono", async () => {
  const app = new Hono().get(
    "/missing",
    ...ssr((context) => {
      context.status(404);
      context.header("Cache-Control", "no-store");
      context.get("page").title = "Missing";
      return () => "Not found";
    }),
  );

  const response = await app.request("/missing");
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-rendered")).toBe("yes");
  expect(await response.text()).toBe("<title>Missing</title>Not found");
});

test("SSR redirects remain passthrough responses", async () => {
  const app = new Hono().get("/old", ...ssr((context) => context.redirect("/new")));

  const response = await app.request("/old");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/new");
});

test("awaits async page preparation before rendering and skips redirects", async () => {
  let preparations = 0;
  const prepared = createStatusPreservingSsrHandler(html, async (c) => {
    await Promise.resolve();
    preparations++;
    c.get("page").title = "Prepared snapshot";
  });
  const app = new Hono().get("/page", ...prepared(() => () => "Page")).get("/redirect", ...prepared((c) => c.redirect("/page")));
  expect(await (await app.request("/page")).text()).toBe("<title>Prepared snapshot</title>Page");
  expect((await app.request("/redirect")).status).toBe(302);
  expect(preparations).toBe(1);
});
