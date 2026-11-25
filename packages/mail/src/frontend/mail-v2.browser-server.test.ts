import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// In one test process the first SSR plugin that loads an island compiles it: a render test that renders the mailbox
// page registers its own plugin and loads the pilot's island before the v2 harness starts (CI's Mail "rest" part).
// The harness must still send every island chunk its markup names.
const cache = resolve(import.meta.dir, "../../node_modules/.cache");
mkdirSync(cache, { recursive: true });
const other = mkdtempSync(join(cache, "mail-v2-other-plugin-"));
registerSsrTestPlugin({ dev: true, rootDir: other });
await import("./MailWorkspaceV2.island");
const { startMailV2Server, MAIL_V2_PATH } = await import("./mail-v2.browser-server");
const server = await startMailV2Server({ now: () => Date.parse("2026-11-20T09:00:00Z") });
afterAll(async () => {
  await server.stop();
  rmSync(other, { recursive: true, force: true });
});

test("the v2 harness sends every island chunk its page names, also after another SSR plugin loaded the island", async () => {
  const html = await (await fetch(`${server.url}${MAIL_V2_PATH}`)).text();
  const ids = [...new Set([...html.matchAll(/<solid-island[^>]*data-id="([^"]+)"/g)].map((match) => match[1]))];
  expect(ids.length).toBeGreaterThan(0);
  const statuses = await Promise.all(ids.map(async (id) => [id, (await fetch(`${server.url}/_ssr/${id}.js`)).status] as const));
  expect(statuses.filter(([, status]) => status !== 200)).toEqual([]);
}, 120_000);
