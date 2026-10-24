import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../ui/test/browser";
import {
  type WorkflowMachineAuthorityChange,
  WorkflowMachineAuthorityChangeSchema,
  WorkflowMachineAuthoritySchema,
} from "../../../workflows/contracts";

const cache = resolve(import.meta.dir, "../../../../node_modules/.cache");
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, "grids-machine-authority-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  componentRoots: [resolve(import.meta.dir, "../../../../test/fixtures/machine-authority")],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Fixture } = await import("../../../../test/fixtures/machine-authority/page");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not build authority fixture styles");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          `<style>${css} solid-island{display:contents}</style></head><body class="k2b-ui">` +
          renderToString(() => createComponent(Fixture, {})) +
          '<script type="module">await Promise.all([...document.querySelectorAll("solid-island")].map(e=>import("/_ssr/"+e.dataset.id+".js")))</script></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop(true);
  }
});

const agentId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const mandateId = "33333333-3333-4333-8333-333333333333";
const replacementId = "44444444-4444-4444-8444-444444444444";
for (const [width, theme] of [
  [1440, "light"],
  [768, "dark"],
  [390, "dark"],
] as const) {
  test(`${width}px ${theme}: typed picker, stale replacement conflict, recovery and revocation`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    let current = WorkflowMachineAuthoritySchema.parse({
      hasHumanOwner: true,
      serviceAccountId: null,
      name: null,
      kind: null,
      accountStatus: null,
      mandate: null,
      canConfigure: true,
    });
    let readFails = true,
      conflict = false;
    const writes: WorkflowMachineAuthorityChange[] = [];
    const searches: URL[] = [];
    try {
      await page.addInitScript((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/accounts/entities") {
          searches.push(url);
          const accounts =
            url.searchParams.get("search") === "none"
              ? []
              : [
                  { id: agentId, name: "Inventory agent", kind: "agent", appId: null, resourceType: null, resourceId: null },
                  { id: serviceId, name: "Nightly service", kind: "standalone", appId: null, resourceType: null, resourceId: null },
                ];
          return route.fulfill({ json: { items: accounts.map((serviceAccount) => ({ kind: "service_account", serviceAccount })) } });
        }
        if (request.method() === "PUT") {
          const body = WorkflowMachineAuthorityChangeSchema.parse(request.postDataJSON());
          writes.push(body);
          if (conflict) {
            current = {
              ...current,
              hasHumanOwner: false,
              serviceAccountId: serviceId,
              name: "Nightly service",
              kind: "standalone",
              mandate: { id: replacementId, revision: 2, state: "paused", permissionCap: "write" },
            };
            conflict = false;
            return route.fulfill({ status: 409, json: { message: "Authority changed" } });
          }
          if (body.action === "assign")
            current = {
              ...current,
              hasHumanOwner: false,
              serviceAccountId: agentId,
              name: "Inventory agent",
              kind: "agent",
              accountStatus: "active",
              mandate: { id: mandateId, revision: 1, state: "active", permissionCap: "write" },
            };
          else if (current.mandate)
            current = {
              ...current,
              hasHumanOwner: false,
              mandate: {
                ...current.mandate,
                revision: current.mandate.revision + 1,
                state: body.action === "pause" ? "paused" : body.action === "resume" ? "active" : "revoked",
              },
            };
        } else if (readFails) return route.fulfill({ status: 503, json: { message: "Unavailable" } });
        return route.fulfill({ json: current });
      });
      await page.goto(server.url.toString());
      expect(await page.locator("solid-island[data-id][data-props]").count()).toBe(1);
      await page.getByText("Execution authority could not be loaded.", { exact: true }).waitFor();
      readFails = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByText("Automatic runs use the existing human owner.", { exact: true }).waitFor();
      const picker = page.getByPlaceholder("Choose an execution account…");
      await picker.fill("none");
      await page.getByText("No results found", { exact: true }).waitFor();
      await picker.fill("Inventory");
      const candidate = page.getByRole("button", { name: "Inventory agent Agent", exact: true });
      await candidate.waitFor();
      await page.getByRole("button", { name: "Nightly service Service account", exact: true }).waitFor();
      expect(searches.at(-1)!.searchParams.get("kinds")).toBe("service_account");
      expect(searches.at(-1)!.searchParams.get("service_account_kinds")).toBe("standalone,agent");
      expect(searches.at(-1)!.searchParams.get("service_account_status")).toBe("active");
      await candidate.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Pause mandate", exact: true }).waitFor();
      expect(writes[0]).toEqual({ action: "assign", serviceAccountId: agentId, expected: { serviceAccountId: null, mandate: null } });
      await page.getByRole("button", { name: "Pause mandate", exact: true }).click();
      await page.getByRole("button", { name: "Resume mandate", exact: true }).waitFor();
      conflict = true;
      await page.getByRole("button", { name: "Resume mandate", exact: true }).click();
      await page
        .getByRole("alert")
        .getByText("Execution authority changed. Review the current owner before trying again.", { exact: true })
        .waitFor();
      expect(writes.at(-1)).toEqual({ action: "resume", expected: { serviceAccountId: agentId, mandate: { id: mandateId, revision: 2 } } });
      expect(await page.locator("section").textContent()).toContain("Nightly service");
      await page.getByRole("button", { name: "Reload authority", exact: true }).click();
      await page.getByRole("button", { name: "Revoke mandate", exact: true }).click();
      await page.getByText("Blocked", { exact: true }).waitFor();
      expect(writes.at(-1)).toEqual({
        action: "revoke",
        expected: { serviceAccountId: serviceId, mandate: { id: replacementId, revision: 2 } },
      });
      expect(await page.getByRole("button", { name: "Resume mandate", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator("[data-ssr-error]").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
}
