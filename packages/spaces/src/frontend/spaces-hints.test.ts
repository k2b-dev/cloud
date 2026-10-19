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
const { firstOpenSpacesHint, spaceHintCandidates } = await import("./spaces-hints");

const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: person });
    await next();
  })
  .get("/", (c) =>
    c.json({
      open: firstOpenSpacesHint(c, spaceHintCandidates(c.req.query("single") === "true" ? 1 : 2)),
    }),
  );

test("server chooses only the first allowed unseen hint, preserving the ordered remainder for later views", async () => {
  expect(await (await app.request("/")).json()).toEqual({ open: "spaces.view-tabs" });
  expect(await (await app.request("/?single=true")).json()).toEqual({ open: "spaces.view-tabs" });
  const cookie = "cloud_seen_hints=spaces.view-tabs";
  expect(await (await app.request("/", { headers: { Cookie: cookie } })).json()).toEqual({ open: "spaces.space-menu" });
  const seenMobileHints = `${cookie}~spaces.space-menu`;
  expect(await (await app.request("/", { headers: { Cookie: seenMobileHints } })).json()).toEqual({ open: "spaces.sidebar-switch" });
  expect(await (await app.request("/?single=true", { headers: { Cookie: seenMobileHints } })).json()).toEqual({});
  expect(await (await app.request("/", { headers: { Cookie: `${seenMobileHints}~spaces.sidebar-switch` } })).json()).toEqual({});
});
