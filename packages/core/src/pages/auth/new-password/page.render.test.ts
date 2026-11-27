import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "core-new-password-page-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(services.coreSettings, "get").mockResolvedValue(undefined as never),
    spyOn(cloud, "listLegalLinks").mockResolvedValue([]),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** The server-rendered page for a link with this `ipa-uid`, decoded as a browser shows its text. */
const page = async (uid: string) => {
  const app = new Hono().get("/auth/new-password", ...handler);
  const response = await app.request(`https://cloud.example.test/auth/new-password?ipa-uid=${encodeURIComponent(uid)}`);
  expect(response.status).toBe(200);
  return response.text();
};

// The name in the link is anyone's to write: it only fills the name field, where it can be changed, and never stands
// on the page as a fact of the installation.
test("the user name from the link stays an editable field, bounded, and is never shown as a fixed fact", async () => {
  const crafted = `Ihr Konto wurde gesperrt. Rufen Sie 0800 123 an. ${"x".repeat(400)}`;
  const html = await page(crafted);
  const field = /<input[^>]*autocomplete="username"[^>]*>/.exec(html)?.[0] ?? "";
  expect(field).not.toBe("");
  expect(field).not.toMatch(/\b(readonly|disabled)\b/);
  const value = /value="([^"]*)"/.exec(field)?.[1] ?? "";
  expect(value.startsWith("Ihr Konto wurde gesperrt.")).toBe(true);
  expect(value.length).toBe(255);
  // no fact names the user, and the text appears nowhere but in the field's value (and the island's props)
  expect(html).not.toMatch(/<dt>Username<\/dt>/);
  const outsideField = html.replace(field, "").replace(/data-props="[^"]*"/g, "");
  expect(outsideField).not.toContain("Ihr Konto wurde gesperrt");
});

test("a page without a name in the link asks for it in the same field", async () => {
  const html = await page("");
  expect(/<input[^>]*autocomplete="username"[^>]*>/.test(html)).toBe(true);
});
