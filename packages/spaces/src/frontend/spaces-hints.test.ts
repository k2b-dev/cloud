import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { person } from "../../../cloud/src/_internal/define-app.test-fixture";

const root = mkdtempSync(join(tmpdir(), "spaces-hints-test-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { firstOpenSpacesHint } = await import("./spaces-hints");

const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: person });
    await next();
  })
  .get("/", (c) =>
    c.json({
      open: firstOpenSpacesHint(c, [
        { id: "spaces.sidebar-switch", allowed: c.req.query("single") !== "true" },
        { id: "spaces.view-tabs", allowed: true },
        { id: "spaces.space-menu", allowed: true },
      ]),
    }),
  );

test("server chooses only the first allowed unseen hint, preserving the ordered remainder for later views", async () => {
  expect(await (await app.request("/")).json()).toEqual({ open: "spaces.sidebar-switch" });
  expect(await (await app.request("/?single=true")).json()).toEqual({ open: "spaces.view-tabs" });
  const cookie = "cloud_seen_hints=spaces.sidebar-switch~spaces.view-tabs";
  expect(await (await app.request("/", { headers: { Cookie: cookie } })).json()).toEqual({ open: "spaces.space-menu" });
  expect(await (await app.request("/", { headers: { Cookie: `${cookie}~spaces.space-menu` } })).json()).toEqual({});
});
