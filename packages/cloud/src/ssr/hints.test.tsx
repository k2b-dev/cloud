import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { markHintSeen as markHintSeenInBrowser } from "../browser/hints";
import type { AuthContext } from "../server/middleware/auth";
import { hintOpen, markHintSeen } from "./hints";

const root = mkdtempSync(resolve(tmpdir(), "cloud-hints-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { MovedHint } = await import("@k2b/ui");
const { person } = await import("../_internal/define-app.test-fixture");
const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    if (c.req.query("anonymous") !== "true") c.set("actor", { kind: "user", user: person });
    await next();
  })
  .get("/old", (c) =>
    c.html(
      renderToString(() =>
        createComponent(MovedHint, {
          open: hintOpen(c, "files.tags", { allowed: c.req.query("allowed") !== "false" }),
          target: () => undefined,
          onDismiss: () => {},
          action: { label: "Show filters", href: "/new" },
          children: "Tags moved to the filters.",
        }),
      ),
    ),
  )
  .get("/new", (c) => {
    c.header("Set-Cookie", "other=kept; Path=/");
    markHintSeen(c, "files.tags");
    return c.text("Filters");
  });

afterEach(() => setSystemTime());

test("an allowed signed-in first request renders the hint; anonymous and disallowed requests omit it", async () => {
  const first = await app.request("/old");
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("k2b-moved-hint");
  for (const path of ["/old?allowed=false", "/old?anonymous=true"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("k2b-moved-hint");
  }
});

test("a browser dismissal persists through the next server render", async () => {
  setSystemTime(new Date("2026-10-18T12:00:00Z"));
  const dom = createDomTestHarness();
  try {
    document.cookie = "cloud_seen_hints=older.hint; Path=/";
    markHintSeenInBrowser("files.tags");
    expect(document.cookie).toContain("cloud_seen_hints=older.hint~files.tags");
    const reload = await app.request("/old", { headers: { Cookie: document.cookie } });
    expect(reload.status).toBe(200);
    expect(await reload.text()).not.toContain("k2b-moved-hint");
    expect(() => markHintSeenInBrowser("bad/id")).toThrow("Invalid hint id");
  } finally {
    dom.cleanup();
  }
});

test("using the new path appends a cookie and suppresses the old hint, including behind an HTTPS gateway", async () => {
  const response = await app.request("http://app:3000/new", {
    headers: { Cookie: "cloud_seen_hints=older.hint", "x-forwarded-proto": "https" },
  });
  const cookies = response.headers.getSetCookie();
  expect(cookies).toContain("other=kept; Path=/");
  const seen = cookies.find((cookie) => cookie.startsWith("cloud_seen_hints="));
  expect(seen).toContain("older.hint~files.tags");
  expect(seen).toEndWith("; Secure");
  const reload = await app.request("/old", { headers: { Cookie: seen!.split(";")[0]! } });
  expect(reload.status).toBe(200);
  expect(await reload.text()).not.toContain("k2b-moved-hint");
  expect((await app.request("https://cloud.example/new")).headers.get("Set-Cookie")).toContain("; Secure");
  expect((await app.request("http://cloud.example/new")).headers.get("Set-Cookie")).not.toContain("; Secure");
});

test("several hints marked in one response all stay seen", async () => {
  const probe = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", { kind: "user", user: person });
      await next();
    })
    .get("/", (c) => {
      markHintSeen(c, "files.tags");
      markHintSeen(c, "files.views");
      return c.text(String(hintOpen(c, "files.tags", { allowed: true })));
    });
  const response = await probe.request("/", { headers: { Cookie: "cloud_seen_hints=older.hint" } });
  expect(await response.text()).toBe("false");
  // The browser stores the last cookie of a name, so the last one carries every id.
  const last = response.headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith("cloud_seen_hints="))
    .at(-1);
  expect(last?.split(";")[0]).toBe("cloud_seen_hints=older.hint~files.tags~files.views");
});

test("invalid server hint ids throw before testing access", async () => {
  const probe = new Hono().get("/", (c) => {
    expect(() => hintOpen(c, "Bad/id", { allowed: false })).toThrow("Invalid hint id");
    expect(() => markHintSeen(c, "Bad/id")).toThrow("Invalid hint id");
    return c.text("ok");
  });
  expect((await probe.request("/")).status).toBe(200);
});
